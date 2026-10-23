const MAX_TEXT = 50_000;

export default async function contents(args: { urls: string[] }) {
  const response = await fetch("https://api.exa.ai/contents", {
    method: "POST",
    headers: {
      "x-api-key": process.env.EXA_API_KEY ?? "",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      urls: args.urls,
      text: { maxCharacters: Math.floor(MAX_TEXT / args.urls.length) },
    }),
  });
  if (!response.ok) throw new Error(`Exa: HTTP ${response.status}`);
  const { results, statuses } = (await response.json()) as {
    results: { url: string; title?: string; text?: string }[];
    statuses?: { id: string; status: string; error?: { tag?: string } }[];
  };
  return {
    pages: results.map(({ url, title, text }) => ({ url, title, text })),
    failed: (statuses ?? [])
      .filter((s) => s.status !== "success")
      .map((s) => ({ url: s.id, error: s.error?.tag })),
  };
}
