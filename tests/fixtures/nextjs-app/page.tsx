// Next.js App Router page — async by convention
export default async function Page() {
  return <main><h1>Hello</h1></main>;
}

export async function generateMetadata() {
  return { title: 'My App' };
}
