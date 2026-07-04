import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token, chatId, text } = body;

    if (!token || !chatId || !text) {
      return NextResponse.json(
        { ok: false, error: 'token, chatId and text are required' },
        { status: 400 }
      );
    }

    const url = `https://tapi.bale.ai/bot${token}/sendMessage`;
    const payload = {
      chat_id: String(chatId),
      text: String(text),
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Bale API error:', data);
      return NextResponse.json(
        { ok: false, error: data.description || 'Bale API error', details: data },
        { status: response.status }
      );
    }

    return NextResponse.json({ ok: true, result: data });
  } catch (error) {
    console.error('Bale send error:', error);
    return NextResponse.json(
      { ok: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
