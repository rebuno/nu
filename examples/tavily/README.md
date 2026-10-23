# nu-tavily

Web search and page reading for [Nu](https://github.com/rebuno/nu) through
[Tavily](https://tavily.com).

Get an API key from Tavily, then install the package and give Nu the key:

```bash
nu install ./examples/tavily
printf %s '<API key>' | nu secret set TAVILY_API_KEY
```

| Tool | Does |
|---|---|
| `tavily__search` | Searches the web, news, or finance, and returns the relevant text from each page |
| `tavily__extract` | Reads up to 20 pages and returns their content as markdown |

The suggested rules let Nu search and read pages without asking.
