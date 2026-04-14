import { env } from 'cloudflare:workers';
import type { Product } from '../data/products';

// Default seed data — used when KV is empty or unavailable
import { products as defaultProducts } from '../data/products';

const KV_KEY = 'products';

function getKV(): KVNamespace | null {
  return (env as any).INVENTORY ?? null;
}

export async function getProducts(): Promise<Product[]> {
  const kv = getKV();
  if (!kv) return defaultProducts;

  const data = await kv.get(KV_KEY);
  if (!data) {
    await kv.put(KV_KEY, JSON.stringify(defaultProducts));
    return defaultProducts;
  }
  return JSON.parse(data) as Product[];
}

export async function getProduct(id: string): Promise<Product | null> {
  const products = await getProducts();
  return products.find((p) => p.id === id) ?? null;
}

export async function saveProducts(products: Product[]): Promise<void> {
  const kv = getKV();
  if (!kv) throw new Error('KV not available');
  await kv.put(KV_KEY, JSON.stringify(products));
}

export async function upsertProduct(product: Product): Promise<void> {
  const products = await getProducts();
  const idx = products.findIndex((p) => p.id === product.id);
  if (idx >= 0) products[idx] = product;
  else products.push(product);
  await saveProducts(products);
}

export async function deleteProduct(id: string): Promise<void> {
  const products = await getProducts();
  await saveProducts(products.filter((p) => p.id !== id));
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
