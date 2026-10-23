# nu-exa

Web search and page reading for [Nu](https://github.com/rebuno/nu) through
[Exa](https://exa.ai), which searches by meaning.

Get an API key from Exa, then install the package and give Nu the key:

```bash
nu install ./examples/exa
printf %s '<API key>' | nu secret set EXA_API_KEY
```

| Tool | Does |
|---|---|
| `exa__search` | Finds pages that match a description, with optional domain and date filters |
| `exa__contents` | Reads pages and returns their text |

The suggested rules let Nu search and read pages without asking.
