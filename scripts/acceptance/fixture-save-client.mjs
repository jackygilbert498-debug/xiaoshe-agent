/** Shared client for the two owned fixtures, not a general HTTP safety policy.
 * Their listed 4xx routes reject before writing. A 5xx, lost response, or
 * failed readback can follow a write, so those outcomes must stay unknown.
 * This contains no expected schema or source values and never retries. */
export const fixtureSaveClient = `
form.onsubmit=async event=>{
  event.preventDefault();
  let body;
  try{body=JSON.stringify(JSON.parse(payload.value));}
  catch{status.textContent='输入不是可解析的 JSON，本次未发送；请核对输入。';return;}
  status.textContent='正在保存';
  try{
    const response=await fetch(base+'save',{method:'POST',headers:{'Content-Type':'application/json'},body});
    if(response.status===409){status.textContent='服务器拒绝本次重复提交（HTTP 409）；请查看已保存记录，不要重复提交。';return;}
    if([400,403,404,405,415,429].includes(response.status)){
      status.textContent='服务器拒绝本次请求（HTTP '+response.status+'），未接受本次提交；请核对输入，不要原样重发。';return;
    }
    if(!response.ok)throw Error('save outcome unknown');
    await response.json();
    await observe();
  }catch{status.textContent='保存结果待确认；请先查看已保存记录，不要重复提交';}
};`
