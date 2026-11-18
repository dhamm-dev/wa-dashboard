import { privatePreview } from './private-preview.js';

export const publicSignupEnabled = () => !privatePreview && process.env.DHEXBOT_PRIVATE_PREVIEW !== '1' && process.env.DHEXBOT_PUBLIC_SIGNUP === '1';
