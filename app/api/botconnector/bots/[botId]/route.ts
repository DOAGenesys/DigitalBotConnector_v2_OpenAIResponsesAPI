import { NextResponse } from 'next/server';
import { getBots } from '@/lib/bots';
import logger from '@/lib/logger';

// Change the function signature here
export async function GET(request: Request, context: { params: { botId: string } }) {
  // Access botId from the context object
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
