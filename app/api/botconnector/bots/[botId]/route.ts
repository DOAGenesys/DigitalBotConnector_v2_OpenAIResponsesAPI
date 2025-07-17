import { type NextRequest, NextResponse } from 'next/server';
import { getBots } from '@/lib/bots';
import logger from '@/lib/logger';

export async function GET(request: NextRequest, context: { params: { botId: string } }) {
  const botId = context.params.botId;
  logger.info(`GET /botconnector/bots/${botId}`);

  const bots = getBots();
  const bot = bots.find(b => b.id === botId);

  if (!bot) {
    logger.warn(`Bot not found: ${botId}`);
    return NextResponse.json({ error: 'Bot not found' }, { status: 404 });
  }
  
  return NextResponse.json(bot);
}
