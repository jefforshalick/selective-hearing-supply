import { env } from 'cloudflare:workers';

const IMAGE_BASE_URL = 'https://images.supply.selectivehear.ing';

function getR2(): R2Bucket | null {
  return (env as any)?.PRODUCT_IMAGES ?? null;
}

export async function uploadImage(file: File, productId: string): Promise<string> {
  const r2 = getR2();
  if (!r2) throw new Error('R2 not available');

  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg';
  const key = `products/${productId}.${ext}`;

  await r2.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || 'image/jpeg' },
  });

  return `${IMAGE_BASE_URL}/${key}`;
}

export async function deleteImage(imageUrl: string): Promise<void> {
  const r2 = getR2();
  if (!r2) return;
  const key = imageUrl.replace(`${IMAGE_BASE_URL}/`, '');
  await r2.delete(key);
}
