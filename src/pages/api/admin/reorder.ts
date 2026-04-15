export const prerender = false;
import type { APIRoute } from 'astro';
import { getProducts, saveProducts } from '../../../lib/products';

export const POST: APIRoute = async ({ request }) => {
  try {
    const { ids } = (await request.json()) as { ids: string[] };
    if (!Array.isArray(ids)) return new Response('Invalid', { status: 400 });

    const products = await getProducts();
    const map = new Map(products.map((p) => [p.id, p]));
    const reordered = ids.map((id) => map.get(id)).filter(Boolean) as typeof products;

    // Append any products not in the ids list (safety net)
    for (const p of products) {
      if (!ids.includes(p.id)) reordered.push(p);
    }

    await saveProducts(reordered);
    return new Response('ok', { status: 200 });
  } catch {
    return new Response('Error', { status: 500 });
  }
};
