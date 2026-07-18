import { NextRequest, NextResponse } from 'next/server';
export const runtime = 'edge'

/**
 * Bale Send API
 * =============
 *
 * Sends a message to a Bale bot chat.
 *
 * ✓ Cloudflare-ready: works in Edge Runtime
 * ✓ Better error handling: includes actual error message in response
 */

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

    // ✓ Handle non-JSON responses gracefully
    const responseText = await response.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      // Response is not JSON — return the raw text as error
      return NextResponse.json(
        { ok: false, error: `Bale API returned non-JSON response (status ${response.status}): ${responseText.substring(0, 200)}` },
        { status: 502 }
      );
    }

    if (!response.ok) {
      return NextResponse.json(
        { ok: false, error: data.description || data.message || 'Bale API error', details: data },
        { status: response.status }
      );
    }

    return NextResponse.json({ ok: true, result: data });
  } catch (error) {
    // ✓ Include the actual error message in the response
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { ok: false, error: `Internal server error: ${message}` },
      { status: 500 }
    );
  }
}
