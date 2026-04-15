/**
 * Cloudflare Turnstile 验证工具
 * 用于验证前端提交的 Turnstile token
 */

interface TurnstileResponse {
  success: boolean;
  'error-codes'?: string[];
  challenge_ts?: string;
  hostname?: string;
}

interface TurnstileVerifyResult {
  success: boolean;
  error?: string;
}

export async function verifyTurnstileToken(
  token: string,
  secretKey: string,
  remoteIp?: string
): Promise<TurnstileVerifyResult> {
  try {
    const body = new URLSearchParams({
      secret: secretKey,
      response: token,
      ...(remoteIp && { remoteip: remoteIp })
    });

    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const data: TurnstileResponse = await response.json();

    if (data.success) {
      return { success: true };
    }

    const errorCodes = data['error-codes'] || [];
    const errorMessage = errorCodes.length > 0 
      ? `验证失败: ${errorCodes.join(', ')}` 
      : '验证失败';

    return { success: false, error: errorMessage };
  } catch (error) {
    console.error('[Turnstile] Verify error:', error);
    return { success: false, error: '验证服务错误' };
  }
}
