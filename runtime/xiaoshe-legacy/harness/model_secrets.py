"""Current-user storage for model-provider secrets."""
from __future__ import annotations

import base64
import ctypes
import json
import os
from pathlib import Path
import secrets
from typing import Protocol

from harness import _io


class SecretStoreError(RuntimeError):
    """The protected secret-store file could not be safely read or written."""


class SecretCodec(Protocol):
    warning: str | None

    def protect(self, raw: bytes) -> bytes: ...

    def unprotect(self, raw: bytes) -> bytes: ...


class _PrivateFileCodec:
    warning = "系统凭据库不可用，密钥仅由本机文件权限保护"

    def protect(self, raw: bytes) -> bytes:
        return raw

    def unprotect(self, raw: bytes) -> bytes:
        return raw


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_ulong), ("pbData", ctypes.POINTER(ctypes.c_byte))]


class _WindowsDpapiCodec:
    warning = None
    _CRYPTPROTECT_UI_FORBIDDEN = 0x1

    @staticmethod
    def _blob(raw: bytes) -> tuple[_DataBlob, ctypes.Array[ctypes.c_char]]:
        buffer = ctypes.create_string_buffer(raw)
        return (
            _DataBlob(len(raw), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte))),
            buffer,
        )

    def protect(self, raw: bytes) -> bytes:
        return self._crypt(raw, protect=True)

    def unprotect(self, raw: bytes) -> bytes:
        return self._crypt(raw, protect=False)

    def _crypt(self, raw: bytes, *, protect: bool) -> bytes:
        try:
            input_blob, _input_buffer = self._blob(raw)
            output_blob = _DataBlob()
            crypt32 = ctypes.windll.crypt32
            success = (
                crypt32.CryptProtectData(
                    ctypes.byref(input_blob), None, None, None, None,
                    self._CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(output_blob),
                )
                if protect
                else crypt32.CryptUnprotectData(
                    ctypes.byref(input_blob), None, None, None, None,
                    self._CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(output_blob),
                )
            )
            if not success:
                raise OSError("Windows data protection failed")
            try:
                return ctypes.string_at(output_blob.pbData, output_blob.cbData)
            finally:
                ctypes.windll.kernel32.LocalFree(output_blob.pbData)
        except SecretStoreError:
            raise
        except Exception:
            raise SecretStoreError("Windows data protection operation failed") from None


def platform_codec() -> SecretCodec:
    return _WindowsDpapiCodec() if os.name == "nt" else _PrivateFileCodec()


class SecretStore:
    def __init__(self, path: Path, codec: SecretCodec | None = None):
        self._path = Path(path)
        self._codec = codec or platform_codec()
        self.warning = self._codec.warning

    def set(self, ref: str, value: str) -> None:
        _validate_ref(ref)
        if not isinstance(value, str) or not value:
            raise ValueError("密钥不能为空")
        with _io.file_lock(self._path, timeout=5):
            values = self._read()
            values[ref] = value
            self._write(values)

    def get(self, ref: str) -> str:
        _validate_ref(ref)
        return self._read().get(ref, "")

    def delete(self, ref: str) -> None:
        _validate_ref(ref)
        with _io.file_lock(self._path, timeout=5):
            values = self._read()
            if ref in values:
                del values[ref]
                self._write(values)

    def configured(self, ref: str) -> bool:
        return bool(self.get(ref))

    def _read(self) -> dict[str, str]:
        if not self._path.exists():
            return {}
        try:
            encoded = self._path.read_text(encoding="ascii")
            protected = base64.b64decode(encoded.encode("ascii"), validate=True)
            decoded = self._codec.unprotect(protected)
            values = json.loads(decoded.decode("utf-8"))
            if not isinstance(values, dict) or any(
                not isinstance(ref, str) or not isinstance(value, str)
                for ref, value in values.items()
            ):
                raise ValueError("invalid store structure")
            return values
        except Exception:
            raise SecretStoreError("Protected secret store could not be read") from None

    def _write(self, values: dict[str, str]) -> None:
        try:
            raw = json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            protected = self._codec.protect(raw)
            encoded = base64.b64encode(protected).decode("ascii")
            if isinstance(self._codec, _PrivateFileCodec):
                _atomic_write_private_text(self._path, encoded)
                os.chmod(self._path, 0o600)
            else:
                _io.atomic_write_text(self._path, encoded)
        except Exception:
            raise SecretStoreError("Protected secret store could not be written") from None

    def __repr__(self) -> str:
        return f"{type(self).__name__}(path={self._path!r}, configured=<redacted>)"


def _validate_ref(ref: str) -> None:
    if not isinstance(ref, str) or not ref:
        raise ValueError("密钥引用不能为空")


def _atomic_write_private_text(path: Path, text: str) -> None:
    """Atomically write a text file without ever creating a world-readable temp file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(8)}.tmp")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            file.write(text)
            file.flush()
            os.fsync(file.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
        if os.name != "nt":
            try:
                directory_descriptor = os.open(str(path.parent), os.O_RDONLY)
                try:
                    os.fsync(directory_descriptor)
                finally:
                    os.close(directory_descriptor)
            except OSError:
                pass
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise
