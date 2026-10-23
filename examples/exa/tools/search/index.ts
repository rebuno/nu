export default async function search(args: {
  query: string;
  limit?: number;
  domains?: string[];
  since?: string;
}) {
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "x-api-key": process.env.EXA_API_KEY ?? "",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: args.query,
      numResults: args.limit ?? 8,
      includeDomains: args.domains,
      startPublishedDate: args.since,
      contents: { highlights: { maxCharacters: 1000 } },
    }),
  });
  if (!response.ok) throw new Error(`Exa: HTTP ${response.status}`);
  const { results } = (await response.json()) as {
    results: {
      title?: string;
      url: string;
      publishedDate?: string;
      highlights?: string[];
    }[];
  };
  return results.map(({ title, url, publishedDate, highlights }) => ({
    title,
    url,
    published: publishedDate,
    highlights,
  }));
}
