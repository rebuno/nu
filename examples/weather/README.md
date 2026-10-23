# nu-weather

Current weather and forecasts for [Nu](https://github.com/rebuno/nu) from
[Open-Meteo](https://open-meteo.com). It needs no API key.

```bash
nu install ./examples/weather
```

The package is a single skill. Nu reads it when you ask about the weather and
fetches the forecast with `curl` in the sandbox.
