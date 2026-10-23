---
name: weather
description: Get current weather and forecasts for a place. Use when the user asks about weather, temperature, rain, wind, or what to wear.
---

# Weather

Open-Meteo needs no API key.

1. Find the place's coordinates, unless you already know them:

   ```bash
   curl -s "https://geocoding-api.open-meteo.com/v1/search?count=3&name=Paris"
   ```

   `name` is the place name alone, without a state or country, URL-encoded.
   Pick the result that matches, and ask if it's unclear.

2. Get the forecast, with `LAT` and `LON` from that result:

   ```bash
   curl -s "https://api.open-meteo.com/v1/forecast?latitude=LAT&longitude=LON&timezone=auto&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=3"
   ```

   Add `&temperature_unit=fahrenheit&wind_speed_unit=mph` for places that use
   them, or when the user prefers them. For hourly detail, add
   `&hourly=temperature_2m,precipitation_probability`.

3. Answer briefly. Translate `weather_code`:

   | Code | Meaning |
   |---|---|
   | 0 | Clear |
   | 1, 2, 3 | Mostly clear, partly cloudy, overcast |
   | 45, 48 | Fog |
   | 51 to 57 | Drizzle |
   | 61 to 67 | Rain |
   | 71 to 77 | Snow |
   | 80 to 82 | Rain showers |
   | 85, 86 | Snow showers |
   | 95 to 99 | Thunderstorm |

If you learn where the user lives, remember it so you don't have to ask again.
