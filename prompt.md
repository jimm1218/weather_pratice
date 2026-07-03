# Windy Taiwan Weather Visualizer - AI Generation Prompt

Copy and paste the prompt below into an advanced AI coding assistant (like Gemini 3.5 Flash/Pro, Claude 3.5 Sonnet, or GPT-4o) to reproduce this exact Windy Taiwan Weather Visualizer project.

---

```markdown
Role: Senior GIS Web Developer & UI/UX Expert
Objective: Build a premium, high-fidelity dynamic weather visualization web application similar to Windy, focusing on Taiwan. The application must display animated wind fields, temperature heatmaps, and rainfall heatmaps using live data from the Central Weather Administration (CWA) API. It must feature interactive timeline playbacks, custom date selection, and adjustable time intervals (6, 12, or 24 hours) with smooth frame interpolation.

Project Requirements & Specifications:

1. Back-end Architecture (Python & Flask & Vercel Zero-Config)
- Create a Flask server inside the `api/` folder as `api/index.py` that loads a CWA API authorization token ('CWB_API_KEY') from a local '.env' file located in the parent project root directory.
- Support Vercel serverless environment constraints by checking if `os.environ.get('VERCEL')` is set:
  - If so, redirect write paths for `cwa_observation.json` and `cwa_observation.db` to the writeable `/tmp/` directory.
  - If not, write cache files to the project root directory.
- Implement an automatic cache mechanism: save API payloads to the JSON cache. If the JSON cache file is less than 30 minutes old, read from the cache instead of querying the API.
- Incorporate SQLite3 database logging to the DB cache path:
  - Create a table 'cwa_observations' with a composite constraint `UNIQUE(station_id, obs_time)` to allow appending records hourly rather than overwriting.
  - Automatically drop the table and recreate it if an older version of the schema (with only UNIQUE(station_id)) is detected on startup.
  - Insert or update records using checking logic by searching for existence of '(station_id, obs_time)' before database updates.
- In requests to CWA API ('https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0001-001'), disable SSL verification ('verify=False') and disable urllib3's 'InsecureRequestWarning' to bypass SSL verification errors.
- Expose the following REST endpoints:
  - `GET /api/weather?date=YYYY-MM-DD&hours=N`: Retrieve N timeline steps.
    - First check the database for unique 'obs_time' records matching 'date%'. If >= 2 unique times exist, pull the station records and construct the timeline.
    - If database logs are missing or insufficient, fall back to a dynamic mathematical simulator:
      - Generate N steps from T-(N-1)h to T.
      - Temperature: Sinusoidal daily fluctuation peaking at 14:00.
      - Wind Direction: Rotate the global wind field systematically by 160 degrees over the N steps to make flow changes obvious.
      - Wind Speed: Peak wind speeds in the middle steps with spatial variations to show contrast.
      - Rainfall: Simulate a rain front/band of heavy rain (up to 28mm) sweeping down Taiwan from North (Taipei, lat 25.3) to South (Kenting, lat 21.8) over the timeline.
  - `POST /api/weather/refresh?date=YYYY-MM-DD&hours=N`: Force cache clearance, fetch live API, save to cache and DB, and return the timeline.
  - Serve static frontend assets ('/', '/style.css', '/script.js') relative to the parent project root directory.
- Provide a `vercel.json` in the root directory mapping all web routes and API endpoints to `api/index.py` using rewrites.

2. UI Structure (HTML5 & Leaflet Map)
- Layout a full-screen Leaflet map in 'index.html'. Add a transparent HTML5 canvas overlaid directly on top of the map grid. Enable 'pointer-events: none' on the canvas so clicks pass through to the map.
- Overlay a floating glassmorphic dashboard wrapper:
  - Header: Application brand logo, dynamic clock, and data update timestamp.
  - Sidebar panel: Toggles for layers (Wind Field, Temperature, Rainfall), calendar Date Picker, Time span selection dropdown (6h, 12h, 24h), dynamic refresh button, and help description.
  - Right panel details drawer: Show name, temperature, rain, wind speed, wind direction, humidity, and air pressure of a clicked station.
  - Bottom timeline panel: Floating timeline player with a Play/Pause toggle button, range slider, dynamic ticks, and current step timestamp readout.
  - Bottom legend panel: Legend color bar gradient scale matching the selected layer, plus average and maximum values indicators.

3. Styling Design (CSS3)
- Use Google Font 'Outfit' for text and 'JetBrains Mono' for monospace metrics in 'style.css'.
- Implement a dark glassmorphism system:
  - Base: background `rgba(18, 22, 33, 0.75)`, blur `backdrop-filter: blur(16px)`, border `1px solid rgba(255, 255, 255, 0.08)`.
  - Accent details: `#00ecff` cyan color with soft box glows.
  - Add active scaling animations (scale, shadow glows) and pulse timers for badges.
  - Style Leaflet popups and customized HTML div icon markers (small pulsing dots with inner white centers) to blend with the glass theme.
  - Style range slider tracks and thumbs to glow on hover.

4. Frontend Logic & Math (Vanilla JavaScript)
- Centered on Taiwan coordinates `[23.6978, 120.9605]` at zoom level 8 using CartoDB Dark Matter tiles.
- Wire Date Picker and Range dropdown selectors to trigger re-fetches when changed. Automatically pause playing on change.
- Perform Inverse Distance Weighting (IDW, $p=2$) spatial interpolation on an $80 \times 100$ grid.
- Coastline Masking: Clip the interpolated values around Taiwan. If the distance to the nearest weather station exceeds 0.25 degrees, fade the opacity linearly to 0 at 0.55 degrees.
- Bilinear Offscreen Rendering: Render the IDW color grid once to an offscreen canvas. Stretch and draw this cached canvas onto the screen canvas using `drawImage` in the render loop. This ensures consistent 60 FPS performance when panning/zooming.
- Wind Particle Simulation:
  - Keep 1500 particles flowing.
  - In each frame, perform bilinear interpolation on the pre-computed grid to fetch wind components $u$ and $v$ at the particle's lat/lon.
  - Update position: `lon += u * speedScale`, `lat += v * speedScale` (where `speedScale = 0.0009`).
  - Convert positions using Leaflet's `map.latLngToContainerPoint` and draw vector trails.
  - Save particle trail history in geographical coordinates (Lat/Lon) instead of screen pixels. Convert them to screen space in the draw loop. This keeps trails anchored to the map during pan/zoom.
  - If age exceeds 120 frames or particle goes out of bounds, respawn it.
- Timeline Linear Interpolation:
  - For float timeline indexes (e.g. index 2.45), linearly interpolate weather station values between slot 2 and slot 3 before calculating IDW.
  - For wind direction, use circular shortest-path interpolation:
    ```javascript
    let diff = d1 - d0;
    if (diff > 180) d1 -= 360;
    else if (diff < -180) d1 += 360;
    let interpolatedDir = (d0 + (d1 - d0) * t) % 360;
    ```
  - Interpolate the current time down to the minute and render the timestamp.
- Palette stopping points (R, G, B, Alpha):
  - Temperature: 10°C (deep blue) -> 18°C (cyan) -> 24°C (green) -> 28°C (yellow) -> 33°C (orange) -> 38°C (red).
  - Rainfall: 0mm (transparent) -> 0.2mm (soft blue) -> 1.0mm (cyan) -> 3.0mm (green) -> 8.0mm (yellow) -> 15mm (orange) -> 30mm (red).
  - Wind Speed: 0 m/s (soft dark blue) -> 2 m/s (cyan) -> 4 m/s (greenish-blue) -> 7 m/s (yellow) -> 11 m/s (orange) -> 16 m/s (magenta).
```
