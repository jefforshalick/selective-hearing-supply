export type ProductStatus = 'in_stock' | 'sold_out' | 'coming_soon';

export interface Product {
  id: string;
  name: string;
  category: string;
  price: number | null;
  description: string;
  image: string | null;
  status: ProductStatus;
  stock: number | null;
  dim_l?: number | null;
  dim_w?: number | null;
  dim_h?: number | null;
  dim_unit?: 'in' | 'cm';
  weight?: number | null;
  weight_unit?: 'oz' | 'lb';
  stripe_product_id?: string;
  stripe_price_id?: string | null;
}

export const products: Product[] = [
  {
    id: 'tray-no-1',
    name: 'Tray No. 1',
    category: 'Artisan Storage',
    price: 85,
    description: 'Machined aluminum tray for artisan keycaps. Holds 10 caps. Ships in kraft box. Edition of 20.',
    image: null,
    status: 'in_stock',
    stock: 8,
  },
  {
    id: 'switch-kit-01',
    name: 'Switch Kit 01',
    category: 'Hardware',
    price: 45,
    description: 'A curated sampler of tactile and linear switches. 10 switches, 5 varieties. Try before you commit.',
    image: null,
    status: 'in_stock',
    stock: 14,
  },
  {
    id: 'drop-002',
    name: 'Drop 002',
    category: 'TBD',
    price: null,
    description: 'Not announced yet. Follow for updates when the next drop goes live.',
    image: null,
    status: 'coming_soon',
    stock: null,
  },
];
