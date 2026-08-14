// 启动页脚本：?err=<urlencoded> → 渲染错误面（如实报错不白屏）。
// 无 err 参数时保持「正在启动」态，等待 Rust 侧 location.replace 到带 token 的界面 URL。
(function () {
  "use strict";
  var params = new URLSearchParams(location.search);
  var err = params.get("err");
  if (!err) return;
  document.getElementById("title").textContent = "小蛇服务未能启动";
  document.getElementById("desc").textContent =
    "桥接服务（run.py serve）未在限定时间内就绪或已退出。请按 tauri/BUILD.md 检查 Python 环境后重试。";
  document.getElementById("spin").style.display = "none";
  var box = document.getElementById("err");
  box.style.display = "block";
  box.textContent = err;
})();
