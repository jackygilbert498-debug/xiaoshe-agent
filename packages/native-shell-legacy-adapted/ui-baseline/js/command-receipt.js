import * as net from "./net.js";
import * as store from "./store.js";

export function sendCommandWithReceipt(name, args = {}, { match, timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let offMessage = () => {};
    let offAlert = () => {};

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      offMessage();
      offAlert();
      fn(value);
    };

    offMessage = store.on("message.append", (message) => {
      if (message?.role !== "system") return;
      if (match && !match(message)) return;
      finish(resolve, message);
    });
    offAlert = store.on("system.alert", (alert) => {
      finish(reject, new Error(alert?.text || `${name} 执行失败`));
    });
    timer = setTimeout(
      () => finish(reject, new Error(`${name} 回执超时`)),
      timeoutMs,
    );

    let sent = false;
    try {
      sent = net.command(name, args);
    } catch (error) {
      finish(reject, error);
      return;
    }
    if (!sent) finish(reject, new Error("未连接，命令未发送"));
  });
}
