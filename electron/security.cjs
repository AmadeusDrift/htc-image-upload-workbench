function validateUploadTarget(url,host){const target=new URL(url);if(target.protocol!=='https:'||target.hostname!==host||target.port||target.username||target.password||target.hash||!target.searchParams.has('X-Amz-Signature'))throw Error('上传地址不受信任');return target}
module.exports={validateUploadTarget};
function localDocument(url){
 const {fileURLToPath}=require('node:url');const path=require('node:path');const parsed=new URL(url);
 if(parsed.protocol!=='file:'||parsed.host||parsed.search||parsed.hash)throw Error('Invalid local document');
 const value=fileURLToPath(parsed,{windows:process.platform==='win32'});if(value.includes('\0'))throw Error('Invalid local document');
 return process.platform==='win32'?path.win32.normalize(value).toLowerCase():path.normalize(value);
}
function assertTrustedSender(event,win,expectedURL){
 if(!win||win.isDestroyed?.()||event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw Error('Invalid IPC sender');
 try{const expected=localDocument(expectedURL);if(localDocument(event.sender.getURL())===expected&&localDocument(event.senderFrame.url)===expected)return}catch{}
 throw Error('Invalid IPC sender');
}
module.exports.assertTrustedSender=assertTrustedSender;
