import React, { useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    turnstile: {
      render: (container: string | HTMLElement, options: TurnstileOptions) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

interface TurnstileOptions {
  sitekey: string;
  callback?: (token: string) => void;
  'error-callback'?: (error: unknown) => void;
  'expired-callback'?: () => void;
  theme?: 'light' | 'dark' | 'auto';
  size?: 'normal' | 'compact';
  mode?: 'managed' | 'interactive' | 'non-interactive' | 'invisible';
  'retry'?: 'auto' | 'never';
  'retry-interval'?: number;
}

interface TurnstileProps {
  siteKey: string;
  onVerify: (token: string) => void;
  onError?: (error: string) => void;
  onExpire?: () => void;
  theme?: 'light' | 'dark' | 'auto';
  size?: 'normal' | 'compact';
  className?: string;
  mode?: 'managed' | 'interactive' | 'non-interactive' | 'invisible';
}

let scriptLoaded = false;
let scriptLoading = false;
let widgetId: string | null = null;

const loadTurnstileScript = (onLoad?: () => void, onError?: (err: string) => void) => {
  if (window.turnstile) {
    onLoad?.();
    return;
  }

  if (scriptLoading) {
    const checkInterval = setInterval(() => {
      if (window.turnstile) {
        clearInterval(checkInterval);
        onLoad?.();
      }
    }, 50);
    return;
  }

  scriptLoading = true;
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
  script.async = true;
  script.defer = true;
  script.onload = () => {
    scriptLoaded = true;
    scriptLoading = false;
    onLoad?.();
  };
  script.onerror = () => {
    scriptLoading = false;
    onError?.('验证组件加载失败');
  };
  document.head.appendChild(script);
};

export const Turnstile: React.FC<TurnstileProps> = ({
  siteKey,
  onVerify,
  onError,
  onExpire,
  theme = 'auto',
  size = 'normal',
  className = '',
  mode = 'managed'
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const onVerifyRef = useRef(onVerify);
  const onErrorRef = useRef(onError);
  const onExpireRef = useRef(onExpire);
  const renderedRef = useRef(false);
  const [loaded, setLoaded] = useState(false);

  onVerifyRef.current = onVerify;
  onErrorRef.current = onError;
  onExpireRef.current = onExpire;

  useEffect(() => {
    loadTurnstileScript(
      () => setLoaded(true),
      (err) => onErrorRef.current?.(err)
    );
  }, []);

  useEffect(() => {
    if (!loaded || !window.turnstile || renderedRef.current || !containerRef.current) return;
    
    renderedRef.current = true;
    widgetId = window.turnstile.render(containerRef.current, {
      sitekey: siteKey,
      callback: (token) => onVerifyRef.current?.(token),
      'error-callback': () => {
        onErrorRef.current?.('验证失败');
        renderedRef.current = false;
      },
      'expired-callback': () => {
        onExpireRef.current?.();
        widgetId = null;
        renderedRef.current = false;
      },
      theme,
      size,
      mode,
      'retry': 'never'
    });

    return () => {
      if (widgetId && window.turnstile) {
        try {
          window.turnstile.remove(widgetId);
        } catch (e) {}
      }
    };
  }, [loaded, siteKey, theme, size, mode]);

  return (
    <div 
      ref={containerRef} 
      className={`turnstile-container ${className}`}
      style={{ minHeight: size === 'compact' ? 50 : 65 }}
    />
  );
};

export const resetTurnstile = () => {
  if (widgetId && window.turnstile) {
    try {
      window.turnstile.reset(widgetId);
    } catch (e) {}
  }
  widgetId = null;
};

export default Turnstile;