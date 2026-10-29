import type { CheckoutResponse } from '@rejectradar/contracts';

/** The part of Paddle.js v2 the app uses. */
interface PaddleJs {
  Environment: { set(environment: 'sandbox'): void };
  Initialize(options: { token: string }): void;
  Checkout: {
    open(options: {
      items: { priceId: string; quantity: number }[];
      customData: Record<string, string>;
      customer: { email: string };
      settings: { successUrl: string };
    }): void;
  };
}

declare global {
  interface Window {
    Paddle?: PaddleJs;
  }
}

let loading: Promise<PaddleJs> | null = null;

/** Loads Paddle.js once and sets it up for the environment and client token the API gave; a failed load can be tried again. */
function paddle(checkout: CheckoutResponse): Promise<PaddleJs> {
  loading ??= new Promise<PaddleJs>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.paddle.com/paddle/v2/paddle.js';
    script.onload = () => {
      const p = window.Paddle;
      if (!p) return reject(new Error('Paddle.js did not load'));
      if (checkout.environment === 'sandbox') p.Environment.set('sandbox');
      p.Initialize({ token: checkout.clientToken });
      resolve(p);
    };
    script.onerror = () => {
      script.remove();
      reject(new Error('Paddle.js did not load'));
    };
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

/** Opens Paddle's checkout overlay for what `POST /v1/billing/checkout` answered (spec §10.2). */
export async function openCheckout(checkout: CheckoutResponse): Promise<void> {
  const p = await paddle(checkout);
  p.Checkout.open({
    items: [{ priceId: checkout.priceId, quantity: 1 }],
    customData: checkout.customData,
    customer: { email: checkout.customerEmail },
    settings: { successUrl: checkout.successUrl },
  });
}
