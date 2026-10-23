export default async function search(args: { query: string; limit?: number }) {
  const response = await fetch("https://api.firecrawl.dev/v2/search", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: args.query, limit: args.limit ?? 8 }),
  });
  if (!response.ok) throw new Error(`Firecrawl: HTTP ${response.status}`);
  const { data } = (await response.json()) as {
    data: { web?: { title?: string; url: string; description?: string }[] };
  };
  return (data.web ?? []).map(({ title, url, description }) => ({
    title,
    url,
    description,
  }));
}
