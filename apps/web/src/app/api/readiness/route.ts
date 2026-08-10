import { NextResponse } from 'next/server';

import { getReadiness } from '@/lib/api-client';

// Прокси для клиентской части: адрес API остаётся на сервере и не уезжает в бандл.
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const result = await getReadiness();
  if (!result.ok) {
    return NextResponse.json(
      { status: 'down', dependencies: {}, error: result.error },
      { status: 503 },
    );
  }
  return NextResponse.json(result.data, { status: result.data.status === 'up' ? 200 : 503 });
}
