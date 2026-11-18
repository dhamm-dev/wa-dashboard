const safeBootValue = process.env.DHEXBOT_SAFE_BOOT;
const preview = process.env.DHEXBOT_PRIVATE_PREVIEW === '1';
if (safeBootValue && (safeBootValue !== '1' || !preview)) {
  throw new Error('DHEXBOT_SAFE_BOOT=1 requires DHEXBOT_PRIVATE_PREVIEW=1');
}

if (safeBootValue === '1') {
  await import('./safe-boot.js');
} else {
  await import('./application.js');
}
