# G3 ChangeSet / Review 证据

当前代码级证据（不等同于 G3 Exit Gate 已完成）：

- `tests/test_review_api.py`：临时 Git 仓库中覆盖 Run 完成自动捕获、补丁读取并校验、批准推进验证、漂移 409/stale、请求修改创建后继 Run。
- `tests/test_diff_capture.py`：tracked/staged/untracked、敏感文件、二进制和符号链接边界。
- `tests/test_change_set.py`、`tests/test_review_service.py`：文件归因、未知改动与工作区版本漂移。

运行：

```sh
PYTHONDONTWRITEBYTECODE=1 /opt/miniconda3/bin/python3.13 -X utf8 -m unittest \
  tests.test_git_workspace tests.test_git_status tests.test_artifact_store tests.test_diff_capture \
  tests.test_workspace_version tests.test_change_set tests.test_review_service tests.test_review_api -v
```

尚未满足的 Exit Gate：逐文件大 diff 的按需 artifact、真实浏览器 E2E、Git mode/submodule 矩阵和 Windows 复现。它们不得据此被标记为完成。
