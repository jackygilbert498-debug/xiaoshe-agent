export function createOfflineInboxBridge({ connected, post, workerRequest, notify = () => {} }) {
  let epoch = 0;
  let enabled = true;
  let flushFlight = null;

  async function runFlush(capturedEpoch) {
    const pending = await workerRequest({ type: "GET_PENDING_INTENTS" });
    for (const intent of pending?.intents || []) {
      if (!enabled || capturedEpoch !== epoch) return;
      let response;
      try {
        response = await post("/api/v2/inbox/intents", intent);
      } catch (_) {
        return;
      }
      if (!enabled || capturedEpoch !== epoch) return;
      const receipt = response?.receipt;
      if (!receipt?.receipt_id) continue;
      await workerRequest({ type: "MARK_RECEIPT", receipt: {
        receipt_id: receipt.receipt_id,
        client_id: intent.client_id,
        status: receipt.duplicate ? "duplicate" : "accepted",
      } });
    }
  }

  function flush() {
    if (!enabled || !connected()) return Promise.resolve();
    if (flushFlight) return flushFlight;
    const capturedEpoch = epoch;
    const flight = runFlush(capturedEpoch);
    flushFlight = flight.finally(() => {
      if (flushFlight === wrapped) flushFlight = null;
    });
    const wrapped = flushFlight;
    return wrapped;
  }

  async function revoke(event = {}) {
    enabled = false;
    epoch += 1;
    const active = flushFlight;
    try {
      if (active) await active;
      await workerRequest({ type: "LOGOUT" });
      enabled = true;
      event.onCleared?.();
    } catch (error) {
      event.onError?.(error);
    }
  }

  function authError() {
    notify("离线任务仍保存在本机；请重新配对后继续同步");
  }

  return { flush, revoke, authError };
}
