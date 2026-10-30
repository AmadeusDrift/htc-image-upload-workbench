function validateUploadTarget(url,host){const target=new URL(url);if(target.protocol!=='https:'||target.hostname!==host||target.port||target.username||target.password||target.hash||!target.searchParams.has('X-Amz-Signature'))throw Error('上传地址不受信任');return target}
module.exports={validateUploadTarget};
function assertTrustedSender(event,win,expectedURL){
 if(!win||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||event.sender.getURL()!==expectedURL||event.senderFrame?.url!==expectedURL)throw Error('Invalid IPC sender');
}
module.exports.assertTrustedSender=assertTrustedSender;
