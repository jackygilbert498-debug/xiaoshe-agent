/**
 * Submit a user message through the acknowledged REST path.
 *
 * WebSocket remains the downlink event channel.  A message is only considered
 * sent after /api/send explicitly accepts it, which lets the composer keep an
 * exact retryable draft when the server or network refuses the request.
 */
export async function sendWithReceipt({
  text,
  clientMsgId,
  images = [],
  sendRest,
  onPending,
  onAccepted,
  onRejected,
}) {
  const draft = { text, images: images.slice() };
  const message = {
    msg_id: `local-${clientMsgId}`,
    role: "user",
    content: text,
    ts: new Date().toISOString(),
    images: images.length ? images : undefined,
    _optimistic: true,
    _delivery: "pending",
    client_msg_id: clientMsgId,
  };
  onPending?.(message);

  try {
    const receipt = await sendRest(text, clientMsgId);
    if (!receipt?.accepted) {
      throw new Error(receipt?.reason || "服务端未接受消息");
    }
    message._delivery = "accepted";
    onAccepted?.(message, receipt);
    return message;
  } catch (error) {
    message._delivery = "failed";
    onRejected?.(message, draft, error);
    throw error;
  }
}
