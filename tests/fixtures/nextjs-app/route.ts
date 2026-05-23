// Next.js App Router route handler
// async is required by Next.js convention even without await
export async function GET() {
  return Response.json({ status: 'ok' });
}

export async function POST(request: Request) {
  const body = await request.json();
  return Response.json({ received: body });
}
