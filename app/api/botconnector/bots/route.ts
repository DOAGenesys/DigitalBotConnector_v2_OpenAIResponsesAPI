import { NextResponse } from 'next/server';
import { getBots } from '@/lib/bots';
import logger from '@/lib/logger';

export async function GET() {
  logger.info('GET /botconnector/bots');
  const bots = getBots();
  return NextResponse.json({ entities: bots });
}
