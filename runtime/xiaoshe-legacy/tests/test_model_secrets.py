import os
import stat
import tempfile
import traceback
import unittest
import uuid
from pathlib import Path
from unittest import mock

from harness import _io, model_secrets


class PrefixCodec:
    warning = None

    def protect(self, raw: bytes) -> bytes:
        return b"sealed:" + raw[::-1]

    def unprotect(self, raw: bytes) -> bytes:
        assert raw.startswith(b"sealed:")
        return raw[7:][::-1]


class ExplodingCodec:
    warning = None

    def protect(self, raw: bytes) -> bytes:
        raise RuntimeError("codec-detail")

    def unprotect(self, raw: bytes) -> bytes:
        return raw


class SecretStoreTests(unittest.TestCase):
    def test_round_trip_never_writes_plaintext(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "model_secrets.bin"
            store = model_secrets.SecretStore(path, codec=PrefixCodec())
            value = f"fixture-{uuid.uuid4().hex}"
            store.set("provider-1", value)
            self.assertEqual(store.get("provider-1"), value)
            self.assertNotIn(value.encode("utf-8"), path.read_bytes())
            self.assertNotIn(value, repr(store))

    def test_delete_removes_only_selected_reference(self):
        with tempfile.TemporaryDirectory() as d:
            store = model_secrets.SecretStore(Path(d) / "model_secrets.bin", codec=PrefixCodec())
            store.set("a", "one")
            store.set("b", "two")
            store.delete("a")
            self.assertEqual(store.get("a"), "")
            self.assertEqual(store.get("b"), "two")

    @unittest.skipUnless(os.name == "nt", "Windows DPAPI only")
    def test_windows_default_codec_is_current_user_dpapi(self):
        codec = model_secrets.platform_codec()
        raw = b"dpapi-round-trip"
        sealed = codec.protect(raw)
        self.assertNotEqual(sealed, raw)
        self.assertEqual(codec.unprotect(sealed), raw)

    def test_corrupt_blob_fails_closed_without_secret_text(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "model_secrets.bin"
            path.write_text("not-base64", encoding="ascii")
            store = model_secrets.SecretStore(path, codec=PrefixCodec())
            with self.assertRaises(model_secrets.SecretStoreError) as caught:
                store.get("a")
            self.assertNotIn("not-base64", str(caught.exception))

    @unittest.skipIf(os.name == "nt", "Windows DPAPI is available")
    def test_non_windows_fallback_warns_and_sets_private_permissions(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "model_secrets.bin"
            store = model_secrets.SecretStore(path)
            store.set("provider", "value")
            self.assertIsNotNone(store.warning)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    @unittest.skipIf(os.name == "nt", "POSIX mode bits are required for the private-file fallback")
    def test_fallback_temporary_file_is_private_before_atomic_replace(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "model_secrets.bin"
            observed_modes = []
            original_replace = _io.os.replace

            def inspect_then_replace(source, destination):
                observed_modes.append(stat.S_IMODE(Path(source).stat().st_mode))
                return original_replace(source, destination)

            old_umask = os.umask(0)
            try:
                with mock.patch.object(_io.os, "replace", side_effect=inspect_then_replace):
                    model_secrets.SecretStore(path, codec=model_secrets._PrivateFileCodec()).set("provider", "value")
            finally:
                os.umask(old_umask)

            self.assertEqual(observed_modes, [0o600])

    def test_codec_failure_does_not_expose_its_detail_in_traceback(self):
        with tempfile.TemporaryDirectory() as d:
            store = model_secrets.SecretStore(Path(d) / "model_secrets.bin", codec=ExplodingCodec())
            with self.assertRaises(model_secrets.SecretStoreError) as caught:
                store.set("provider", "value")
            rendered = "".join(traceback.format_exception(caught.exception))
            self.assertNotIn("codec-detail", rendered)


if __name__ == "__main__":
    unittest.main(verbosity=2)
