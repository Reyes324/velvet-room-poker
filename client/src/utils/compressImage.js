// client/src/utils/compressImage.js
// 反馈图片在真的发去服务器（转成 GitHub Issue 附件）之前先在浏览器里压
// 缩——见 docs/superpowers/specs/2026-08-02-user-feedback-system-design.md
// Section 1：长边压到 1600px 以内、控制在 2MB 左右，跟服务端
// FEEDBACK_MAX_IMAGE_BASE64_LENGTH 的上限留出安全余量，不是靠服务端拒绝
// 来把关。
export function compressImage(file, { maxDim = 1600, quality = 0.8 } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => {
          if (!blob) return reject(new Error('图片压缩失败'));
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result; // "data:image/jpeg;base64,...."
            const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
            resolve({ base64, mimeType: 'image/jpeg' });
          };
          reader.onerror = () => reject(new Error('图片读取失败'));
          reader.readAsDataURL(blob);
        },
        'image/jpeg',
        quality,
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('无法读取这张图片'));
    };
    img.src = objectUrl;
  });
}
