// Windy Taiwan Weather Map Logic with Dynamic Timeline Playback
document.addEventListener('DOMContentLoaded', () => {
  // --- Constants and Configuration ---
  const TAIWAN_BOUNDS = {
    latMin: 21.7,
    latMax: 25.5,
    lonMin: 119.3,
    lonMax: 122.5
  };

  // Interpolation grid size (for IDW computation)
  const GRID_W = 80;
  const GRID_H = 100;

  // Layer and Timeline state
  let currentLayer = 'wind'; // 'wind', 'temp', 'rain'
  let timelineData = [];     // Array of timeline slots from API
  let weatherStations = [];  // Current active/interpolated station observations
  let updateTimeStr = '';
  
  // Timeline Playback State
  let currentTimelineIndex = 5.0; // Float index between 0.0 and maxTimelineIndex
  let isPlaying = false;
  let maxTimelineIndex = 5.0;     // Dynamically set based on timelineData length
  const playbackSpeed = 0.008;    // Index increment per frame

  // Grids for weather parameters (precomputed/interpolated dynamically)
  let gridTemp = null;     // 2D Array [H][W]
  let gridRain = null;     // 2D Array [H][W]
  let gridWindU = null;    // 2D Array [H][W]
  let gridWindV = null;    // 2D Array [H][W]
  let gridWindSpeed = null;// 2D Array [H][W]

  // Canvas for offscreen gradient caching
  let offscreenCanvas = document.createElement('canvas');
  offscreenCanvas.width = GRID_W;
  offscreenCanvas.height = GRID_H;
  let offscreenCtx = offscreenCanvas.getContext('2d');

  // Map & Main Canvas
  let map = null;
  let canvas = document.getElementById('weather-canvas');
  let ctx = canvas.getContext('2d');
  let animationFrameId = null;

  // Particle System Configuration
  const PARTICLE_COUNT = 1500;
  let particles = [];
  const particleMaxAge = 120;
  const speedScale = 0.0009; // Lat/Lon degrees per frame per m/s

  // --- UI Elements ---
  const liveClock = document.getElementById('live-clock');
  const dataStatus = document.getElementById('data-status');
  const btnRefresh = document.getElementById('btn-refresh');
  const stationDetailPanel = document.getElementById('station-detail-panel');
  const btnDetailClose = document.getElementById('btn-detail-close');
  
  // Sidebar info readouts
  const valWind = document.getElementById('val-wind');
  const valTemp = document.getElementById('val-temp');
  const valRain = document.getElementById('val-rain');

  // Sidebar selectors
  const dateSelect = document.getElementById('date-select');
  const rangeSelect = document.getElementById('range-select');

  // Legend Elements
  const legendTitle = document.getElementById('legend-title');
  const legendColorBar = document.getElementById('legend-color-bar');
  const legendLblMin = document.getElementById('legend-lbl-min');
  const legendLblMax = document.getElementById('legend-lbl-max');
  const statMax = document.getElementById('stat-max');
  const statAvg = document.getElementById('stat-avg');

  // Timeline Controls
  const btnPlayPause = document.getElementById('btn-play-pause');
  const timelineSlider = document.getElementById('timeline-slider');
  const timelineTicksContainer = document.getElementById('timeline-ticks-container');
  const timelineCurrentTime = document.getElementById('timeline-current-time');

  // --- Initialize Selectors ---
  function initSelectors() {
    const today = new Date().toISOString().split('T')[0];
    dateSelect.value = today;
    dateSelect.setAttribute('max', today); // Prevent choosing future dates

    // Listeners for timeframe updates
    dateSelect.addEventListener('change', () => {
      if (isPlaying) togglePlayState(false);
      fetchWeatherData();
    });
    
    rangeSelect.addEventListener('change', () => {
      if (isPlaying) togglePlayState(false);
      fetchWeatherData();
    });
  }

  // --- Color Palettes ---
  // Temperature: 10°C (Deep blue) -> 40°C (Red)
  const tempPalette = [
    { value: 10, r: 0, g: 80, b: 255 },
    { value: 18, r: 0, g: 190, b: 255 },
    { value: 24, r: 0, g: 255, b: 150 },
    { value: 28, r: 255, g: 235, b: 0 },
    { value: 33, r: 255, g: 120, b: 0 },
    { value: 38, r: 255, g: 0, b: 0 }
  ];

  // Rainfall: 0mm (Transparent) -> 30mm (Red)
  const rainPalette = [
    { value: 0, r: 15, g: 23, b: 42, a: 0.0 },
    { value: 0.2, r: 64, g: 140, b: 255, a: 0.45 },
    { value: 1.0, r: 0, g: 200, b: 255, a: 0.6 },
    { value: 3.0, r: 0, g: 220, b: 100, a: 0.7 },
    { value: 8.0, r: 255, g: 210, b: 0, a: 0.75 },
    { value: 15, r: 255, g: 120, b: 0, a: 0.8 },
    { value: 30, r: 255, g: 0, b: 0, a: 0.9 }
  ];

  // Wind Speed (m/s): 0 (Soft dark blue) -> 16 (Magenta)
  const windPalette = [
    { value: 0, r: 10, g: 30, b: 80, a: 0.35 },
    { value: 2, r: 0, g: 180, b: 220, a: 0.5 },
    { value: 4, r: 0, g: 220, b: 140, a: 0.6 },
    { value: 7, r: 230, g: 220, b: 0, a: 0.65 },
    { value: 11, r: 255, g: 130, b: 0, a: 0.75 },
    { value: 16, r: 220, g: 0, b: 220, a: 0.85 }
  ];

  // --- Initialize Map ---
  function initMap() {
    map = L.map('map', {
      center: [23.6978, 120.9605],
      zoom: 8,
      minZoom: 7,
      maxZoom: 12,
      zoomControl: true
    });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 20
    }).addTo(map);

    map.on('viewreset', updateCanvasSize);
    map.on('move', updateCanvasSize);
    map.on('moveend', updateCanvasSize);

    window.addEventListener('resize', updateCanvasSize);
    updateCanvasSize();
  }

  function updateCanvasSize() {
    const size = map.getSize();
    canvas.width = size.x;
    canvas.height = size.y;
    canvas.style.width = size.x + 'px';
    canvas.style.height = size.y + 'px';
  }

  function updateClock() {
    const now = new Date();
    liveClock.textContent = now.toLocaleTimeString('zh-TW', { hour12: false });
  }
  setInterval(updateClock, 1000);
  updateClock();

  // --- Math Utility: IDW Interpolation ---
  function interpolateGrid() {
    if (weatherStations.length === 0) return;

    gridTemp = [];
    gridRain = [];
    gridWindU = [];
    gridWindV = [];
    gridWindSpeed = [];

    const latRange = TAIWAN_BOUNDS.latMax - TAIWAN_BOUNDS.latMin;
    const lonRange = TAIWAN_BOUNDS.lonMax - TAIWAN_BOUNDS.lonMin;

    for (let r = 0; r < GRID_H; r++) {
      gridTemp[r] = new Float32Array(GRID_W);
      gridRain[r] = new Float32Array(GRID_W);
      gridWindU[r] = new Float32Array(GRID_W);
      gridWindV[r] = new Float32Array(GRID_W);
      gridWindSpeed[r] = new Float32Array(GRID_W);

      const lat = TAIWAN_BOUNDS.latMax - (r / GRID_H) * latRange;

      for (let c = 0; c < GRID_W; c++) {
        const lon = TAIWAN_BOUNDS.lonMin + (c / GRID_W) * lonRange;

        let weightSum = 0;
        let tempSum = 0;
        let rainSum = 0;
        let uSum = 0;
        let vSum = 0;
        let speedSum = 0;
        
        let minDistance = Infinity;

        for (let i = 0; i < weatherStations.length; i++) {
          const s = weatherStations[i];
          const dLat = lat - s.lat;
          const dLon = lon - s.lon;
          const d2 = dLat * dLat + dLon * dLon;
          const d = Math.sqrt(d2);

          if (d < minDistance) {
            minDistance = d;
          }

          if (d < 0.001) {
            weightSum = 1;
            tempSum = s.temp !== null ? s.temp : 0;
            rainSum = s.rain !== null ? s.rain : 0;
            if (s.wind_speed !== null && s.wind_dir !== null) {
              const rad = (s.wind_dir * Math.PI) / 180;
              uSum = s.wind_speed * Math.sin(rad);
              vSum = s.wind_speed * Math.cos(rad);
              speedSum = s.wind_speed;
            } else {
              uSum = 0; vSum = 0; speedSum = 0;
            }
            break;
          }

          const w = 1.0 / d2;
          weightSum += w;

          if (s.temp !== null) tempSum += s.temp * w;
          if (s.rain !== null) rainSum += s.rain * w;
          if (s.wind_speed !== null && s.wind_dir !== null) {
            const rad = (s.wind_dir * Math.PI) / 180;
            uSum += (s.wind_speed * Math.sin(rad)) * w;
            vSum += (s.wind_speed * Math.cos(rad)) * w;
            speedSum += s.wind_speed * w;
          }
        }

        gridTemp[r][c] = weightSum > 0 ? (tempSum / weightSum) : 25;
        gridRain[r][c] = weightSum > 0 ? (rainSum / weightSum) : 0;
        gridWindU[r][c] = weightSum > 0 ? (uSum / weightSum) : 0;
        gridWindV[r][c] = weightSum > 0 ? (vSum / weightSum) : 0;
        gridWindSpeed[r][c] = weightSum > 0 ? (speedSum / weightSum) : 0;
      }
    }

    bakeGradients();
  }

  function getMaskAlpha(degDist) {
    if (degDist < 0.25) return 1.0;
    if (degDist > 0.55) return 0.0;
    return 1.0 - (degDist - 0.25) / 0.3;
  }

  function getColorFromPalette(value, palette, defaultAlpha = 1.0) {
    if (palette.length === 0) return { r: 0, g: 0, b: 0, a: 0 };
    
    if (value <= palette[0].value) {
      const p = palette[0];
      return { r: p.r, g: p.g, b: p.b, a: p.a !== undefined ? p.a : defaultAlpha };
    }
    
    if (value >= palette[palette.length - 1].value) {
      const p = palette[palette.length - 1];
      return { r: p.r, g: p.g, b: p.b, a: p.a !== undefined ? p.a : defaultAlpha };
    }

    for (let i = 0; i < palette.length - 1; i++) {
      const curr = palette[i];
      const next = palette[i+1];
      if (value >= curr.value && value <= next.value) {
        const t = (value - curr.value) / (next.value - curr.value);
        const r = Math.round(curr.r + (next.r - curr.r) * t);
        const g = Math.round(curr.g + (next.g - curr.g) * t);
        const b = Math.round(curr.b + (next.b - curr.b) * t);
        
        const currA = curr.a !== undefined ? curr.a : defaultAlpha;
        const nextA = next.a !== undefined ? next.a : defaultAlpha;
        const a = currA + (nextA - currA) * t;
        
        return { r, g, b, a };
      }
    }
    return { r: 0, g: 0, b: 0, a: 0 };
  }

  function bakeGradients() {}

  function drawGridToOffscreen(layer) {
    if (weatherStations.length === 0) return;
    
    const imgData = offscreenCtx.createImageData(GRID_W, GRID_H);
    const data = imgData.data;

    const latRange = TAIWAN_BOUNDS.latMax - TAIWAN_BOUNDS.latMin;
    const lonRange = TAIWAN_BOUNDS.lonMax - TAIWAN_BOUNDS.lonMin;

    for (let r = 0; r < GRID_H; r++) {
      const lat = TAIWAN_BOUNDS.latMax - (r / GRID_H) * latRange;
      
      for (let c = 0; c < GRID_W; c++) {
        const lon = TAIWAN_BOUNDS.lonMin + (c / GRID_W) * lonRange;
        
        let value = 0;
        let palette = tempPalette;
        let defaultA = 0.55;

        if (layer === 'temp') {
          value = gridTemp[r][c];
          palette = tempPalette;
          defaultA = 0.55;
        } else if (layer === 'rain') {
          value = gridRain[r][c];
          palette = rainPalette;
          defaultA = 0.65;
        } else { 
          value = gridWindSpeed[r][c];
          palette = windPalette;
          defaultA = 0.4;
        }

        let minDist = Infinity;
        for (let i = 0; i < weatherStations.length; i++) {
          const s = weatherStations[i];
          const d = Math.sqrt((lat - s.lat)**2 + (lon - s.lon)**2);
          if (d < minDist) minDist = d;
        }
        const landMask = getMaskAlpha(minDist);

        const color = getColorFromPalette(value, palette, defaultA);
        const idx = (r * GRID_W + c) * 4;
        
        data[idx] = color.r;
        data[idx+1] = color.g;
        data[idx+2] = color.b;
        data[idx+3] = Math.round(color.a * landMask * 255);
      }
    }
    offscreenCtx.putImageData(imgData, 0, 0);
  }

  // --- Wind Flow Particle System ---
  class WindParticle {
    constructor() {
      this.respawn();
    }

    respawn() {
      this.lat = TAIWAN_BOUNDS.latMin + Math.random() * (TAIWAN_BOUNDS.latMax - TAIWAN_BOUNDS.latMin);
      this.lon = TAIWAN_BOUNDS.lonMin + Math.random() * (TAIWAN_BOUNDS.lonMax - TAIWAN_BOUNDS.lonMin);
      this.age = Math.floor(Math.random() * particleMaxAge);
      this.history = [];
      this.speed = 0;
    }

    update() {
      this.age++;
      if (this.age > particleMaxAge) {
        this.respawn();
        return;
      }

      const flow = getWindComponentsAt(this.lat, this.lon);
      if (!flow) {
        this.respawn();
        return;
      }

      this.speed = flow.speed;

      if (this.speed < 0.2 && Math.random() < 0.05) {
        this.respawn();
        return;
      }

      this.history.push({ lat: this.lat, lon: this.lon });
      if (this.history.length > 5) {
        this.history.shift();
      }

      this.lon += flow.u * speedScale;
      this.lat += flow.v * speedScale;

      if (this.lat < TAIWAN_BOUNDS.latMin || this.lat > TAIWAN_BOUNDS.latMax ||
          this.lon < TAIWAN_BOUNDS.lonMin || this.lon > TAIWAN_BOUNDS.lonMax) {
        this.respawn();
      }
    }

    draw(ctx) {
      if (this.history.length < 2) return;

      ctx.beginPath();
      const pt0 = map.latLngToContainerPoint([this.history[0].lat, this.history[0].lon]);
      ctx.moveTo(pt0.x, pt0.y);
      for (let i = 1; i < this.history.length; i++) {
        const pt = map.latLngToContainerPoint([this.history[i].lat, this.history[i].lon]);
        ctx.lineTo(pt.x, pt.y);
      }

      let alpha = 0.55 * (1.0 - this.age / particleMaxAge);
      let colorStr = `rgba(240, 240, 255, ${alpha})`;
      let lineWidth = 1.0;

      if (this.speed > 8) {
        colorStr = `rgba(0, 236, 255, ${alpha + 0.15})`;
        lineWidth = 1.5;
      } else if (this.speed > 14) {
        colorStr = `rgba(255, 235, 0, ${alpha + 0.3})`;
        lineWidth = 2.0;
      }

      ctx.strokeStyle = colorStr;
      ctx.lineWidth = lineWidth;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  }

  function getWindComponentsAt(lat, lon) {
    if (!gridWindU || !gridWindV) return null;

    const latRange = TAIWAN_BOUNDS.latMax - TAIWAN_BOUNDS.latMin;
    const lonRange = TAIWAN_BOUNDS.lonMax - TAIWAN_BOUNDS.lonMin;

    const xPct = (lon - TAIWAN_BOUNDS.lonMin) / lonRange;
    const yPct = (TAIWAN_BOUNDS.latMax - lat) / latRange;

    if (xPct < 0 || xPct >= 1 || yPct < 0 || yPct >= 1) return null;

    const gx = xPct * (GRID_W - 1);
    const gy = yPct * (GRID_H - 1);

    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const x1 = Math.min(x0 + 1, GRID_W - 1);
    const y1 = Math.min(y0 + 1, GRID_H - 1);

    const tx = gx - x0;
    const ty = gy - y0;

    const u00 = gridWindU[y0][x0];
    const u10 = gridWindU[y0][x1];
    const u01 = gridWindU[y1][x0];
    const u11 = gridWindU[y1][x1];
    const u = (1-tx)*(1-ty)*u00 + tx*(1-ty)*u10 + (1-tx)*ty*u01 + tx*ty*u11;

    const v00 = gridWindV[y0][x0];
    const v10 = gridWindV[y0][x1];
    const v01 = gridWindV[y1][x0];
    const v11 = gridWindV[y1][x1];
    const v = (1-tx)*(1-ty)*v00 + tx*(1-ty)*v10 + (1-tx)*ty*v01 + tx*ty*v11;

    const s00 = gridWindSpeed[y0][x0];
    const s10 = gridWindSpeed[y0][x1];
    const s01 = gridWindSpeed[y1][x0];
    const s11 = gridWindSpeed[y1][x1];
    const speed = (1-tx)*(1-ty)*s00 + tx*(1-ty)*s10 + (1-tx)*ty*s01 + tx*ty*s11;

    return { u, v, speed };
  }

  // Pre-populate particles array
  function initParticles() {
    particles = [];
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push(new WindParticle());
    }
  }

  // --- Animation Render Loop ---
  function renderLoop() {
    if (isPlaying && timelineData.length > 0) {
      let idx = parseFloat(timelineSlider.value);
      idx += playbackSpeed;
      if (idx > maxTimelineIndex) {
        idx = 0.0;
      }
      timelineSlider.value = idx;
      currentTimelineIndex = idx;
      onTimelineSliderUpdate();
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const tlPt = map.latLngToContainerPoint([TAIWAN_BOUNDS.latMax, TAIWAN_BOUNDS.lonMin]);
    const brPt = map.latLngToContainerPoint([TAIWAN_BOUNDS.latMin, TAIWAN_BOUNDS.lonMax]);
    const w = brPt.x - tlPt.x;
    const h = brPt.y - tlPt.y;

    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(offscreenCanvas, tlPt.x, tlPt.y, w, h);

    particles.forEach(p => {
      p.update();
      p.draw(ctx);
    });

    animationFrameId = requestAnimationFrame(renderLoop);
  }

  // --- Linear Interpolation of Station States ---
  function updateWeatherStationsInterpolation() {
    if (timelineData.length === 0) return;

    const idx0 = Math.floor(currentTimelineIndex);
    const idx1 = Math.min(idx0 + 1, timelineData.length - 1);
    const t = currentTimelineIndex - idx0;

    const stations0 = timelineData[idx0].data;
    const stations1 = timelineData[idx1].data;

    const map1 = {};
    stations1.forEach(s => {
      map1[s.station_id] = s;
    });

    const interpolated = [];
    stations0.forEach(s0 => {
      const s1 = map1[s0.station_id];
      if (s1) {
        const temp = s0.temp !== null && s1.temp !== null ? s0.temp + (s1.temp - s0.temp) * t : (s0.temp !== null ? s0.temp : s1.temp);
        const rain = s0.rain !== null && s1.rain !== null ? s0.rain + (s1.rain - s0.rain) * t : (s0.rain !== null ? s0.rain : s1.rain);
        const windSpeed = s0.wind_speed !== null && s1.wind_speed !== null ? s0.wind_speed + (s1.wind_speed - s0.wind_speed) * t : (s0.wind_speed !== null ? s0.wind_speed : s1.wind_speed);
        
        let windDir = null;
        if (s0.wind_dir !== null && s1.wind_dir !== null) {
          let d0 = s0.wind_dir;
          let d1 = s1.wind_dir;
          let diff = d1 - d0;
          if (diff > 180) d1 -= 360;
          else if (diff < -180) d1 += 360;
          
          windDir = (d0 + (d1 - d0) * t) % 360;
          if (windDir < 0) windDir += 360;
        } else {
          windDir = s0.wind_dir !== null ? s0.wind_dir : s1.wind_dir;
        }

        const humidity = s0.humidity !== null && s1.humidity !== null ? s0.humidity + (s1.humidity - s0.humidity) * t : (s0.humidity !== null ? s0.humidity : s1.humidity);
        const pressure = s0.pressure !== null && s1.pressure !== null ? s0.pressure + (s1.pressure - s0.pressure) * t : (s0.pressure !== null ? s0.pressure : s1.pressure);

        interpolated.push({
          ...s0,
          temp: temp !== null ? parseFloat(temp.toFixed(1)) : null,
          rain: rain !== null ? parseFloat(rain.toFixed(2)) : null,
          wind_speed: windSpeed !== null ? parseFloat(windSpeed.toFixed(1)) : null,
          wind_dir: windDir !== null ? parseFloat(windDir.toFixed(1)) : null,
          humidity: humidity !== null ? Math.round(humidity) : null,
          pressure: pressure !== null ? parseFloat(pressure.toFixed(1)) : null
        });
      } else {
        interpolated.push(s0);
      }
    });

    weatherStations = interpolated;

    // Interpolate visual timestamp readout
    const time0 = new Date(timelineData[idx0].timestamp);
    const time1 = new Date(timelineData[idx1].timestamp);
    const currentMs = time0.getTime() + (time1.getTime() - time0.getTime()) * t;
    const currentDt = new Date(currentMs);

    const dateStr = currentDt.toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' });
    const timeStr = currentDt.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
    
    timelineCurrentTime.textContent = `${dateStr} ${timeStr}`;

    // Update active highlight ticks in UI
    const labels = document.querySelectorAll('.timeline-tick-label');
    labels.forEach((lbl, index) => {
      if (index === idx0) {
        lbl.classList.add('active');
      } else {
        lbl.classList.remove('active');
      }
    });
  }

  // --- UI Slider Event Handler ---
  function onTimelineSliderUpdate() {
    updateWeatherStationsInterpolation();
    interpolateGrid();
    drawGridToOffscreen(currentLayer);
    drawStationMarkers();
    updateUIStats();
    updateQuickStats();
    updateDetailPanelIfOpen();
  }

  // --- Update UI Legends and Statistics ---
  function updateUIStats() {
    if (weatherStations.length === 0) return;

    let totalVal = 0;
    let maxVal = -Infinity;
    let validCount = 0;
    let maxStation = "";

    weatherStations.forEach(s => {
      let val = null;
      if (currentLayer === 'wind') val = s.wind_speed;
      else if (currentLayer === 'temp') val = s.temp;
      else if (currentLayer === 'rain') val = s.rain;

      if (val !== null) {
        totalVal += val;
        validCount++;
        if (val > maxVal) {
          maxVal = val;
          maxStation = s.station_name;
        }
      }
    });

    const avg = validCount > 0 ? (totalVal / validCount).toFixed(1) : '--';
    const max = maxVal !== -Infinity ? `${maxVal.toFixed(1)} (${maxStation})` : '--';

    statMax.textContent = max;
    statAvg.textContent = avg;

    let titleStr = "";
    let minLbl = "";
    let maxLbl = "";
    let colorBarGradStr = "";

    if (currentLayer === 'wind') {
      titleStr = "風速與流場 (m/s)";
      minLbl = "0 m/s";
      maxLbl = "16+ m/s";
      colorBarGradStr = "linear-gradient(to right, rgb(10,30,80) 0%, rgb(0,180,220) 20%, rgb(0,220,140) 40%, rgb(230,220,0) 60%, rgb(255,130,0) 80%, rgb(220,0,220) 100%)";
    } else if (currentLayer === 'temp') {
      titleStr = "溫度分層設色 (°C)";
      minLbl = "10 °C";
      maxLbl = "40 °C";
      colorBarGradStr = "linear-gradient(to right, rgb(0, 80, 255) 0%, rgb(0, 190, 255) 20%, rgb(0, 255, 150) 40%, rgb(255, 235, 0) 60%, rgb(255, 120, 0) 80%, rgb(255, 0, 0) 100%)";
    } else if (currentLayer === 'rain') {
      titleStr = "累積雨量分層設色 (mm)";
      minLbl = "0 mm";
      maxLbl = "30+ mm";
      colorBarGradStr = "linear-gradient(to right, rgba(15,23,42,0) 0%, rgba(64,140,255,0.5) 10%, rgba(0,200,255,0.7) 25%, rgba(0,220,100,0.8) 45%, rgba(255,210,0,0.85) 65%, rgba(255,120,0,0.9) 85%, rgba(255,0,0,0.9) 100%)";
    }

    legendTitle.textContent = titleStr;
    legendLblMin.textContent = minLbl;
    legendLblMax.textContent = maxLbl;
    legendColorBar.style.background = colorBarGradStr;
  }

  // --- Draw Station Markers ---
  let markersLayer = L.layerGroup();
  let selectedStationId = null;
  
  function drawStationMarkers() {
    markersLayer.clearLayers();
    if (weatherStations.length === 0) return;

    weatherStations.forEach(s => {
      const popupHtml = `
        <div class="popup-station-card">
          <div class="popup-station-title">${s.station_name}</div>
          <div class="popup-station-row">
            <span class="popup-station-lbl">溫度:</span>
            <span class="popup-station-val" style="color: #ff9f1c;">${s.temp !== null ? s.temp + ' °C' : '--'}</span>
          </div>
          <div class="popup-station-row">
            <span class="popup-station-lbl">雨量:</span>
            <span class="popup-station-val" style="color: #48dbfb;">${s.rain !== null ? s.rain + ' mm' : '--'}</span>
          </div>
          <div class="popup-station-row">
            <span class="popup-station-lbl">風速:</span>
            <span class="popup-station-val" style="color: #00ecff;">${s.wind_speed !== null ? s.wind_speed + ' m/s' : '--'}</span>
          </div>
          <div class="popup-station-row">
            <span class="popup-station-lbl">風向:</span>
            <span class="popup-station-val" style="color: #a0a8c0;">${s.wind_dir !== null ? s.wind_dir + '°' : '--'}</span>
          </div>
        </div>
      `;

      const customIcon = L.divIcon({
        className: 'custom-station-marker',
        iconSize: [16, 16],
        iconAnchor: [8, 8]
      });

      const marker = L.marker([s.lat, s.lon], { icon: customIcon });
      marker.bindPopup(popupHtml, { closeButton: false, offset: [0, -5] });

      marker.on('mouseover', function (e) {
        this.openPopup();
      });

      marker.on('click', () => {
        selectedStationId = s.station_id;
        showStationDetails(s);
      });

      markersLayer.addLayer(marker);
    });

    markersLayer.addTo(map);
  }

  function showStationDetails(s) {
    document.getElementById('detail-station-name').textContent = `${s.county} ${s.station_name}`;
    document.getElementById('detail-temp').textContent = s.temp !== null ? `${s.temp} °C` : '--';
    document.getElementById('detail-rain').textContent = s.rain !== null ? `${s.rain} mm` : '--';
    document.getElementById('detail-wind-speed').textContent = s.wind_speed !== null ? `${s.wind_speed} m/s` : '--';
    document.getElementById('detail-wind-dir').textContent = s.wind_dir !== null ? `${s.wind_dir}°` : '--';
    document.getElementById('detail-humidity').textContent = s.humidity !== null ? `${s.humidity} %` : '--';
    document.getElementById('detail-pressure').textContent = s.pressure !== null ? `${s.pressure} hPa` : '--';
    document.getElementById('detail-obs-time').textContent = `觀測時間: ${s.obs_time ? s.obs_time.substring(11,16) : '--'}`;
    
    stationDetailPanel.style.display = 'block';
  }

  function updateDetailPanelIfOpen() {
    if (selectedStationId && stationDetailPanel.style.display === 'block') {
      const s = weatherStations.find(station => station.station_id === selectedStationId);
      if (s) {
        showStationDetails(s);
      }
    }
  }

  // --- Fetch API Weather Data ---
  async function fetchWeatherData(refreshUrl = null) {
    // Construct dynamic url with date/hours parameters from sidebar selectors
    let url = refreshUrl;
    if (!url) {
      url = `/api/weather?date=${dateSelect.value}&hours=${rangeSelect.value}`;
    }

    try {
      const response = await fetch(url, { method: url.includes('refresh') ? 'POST' : 'GET' });
      const resData = await response.json();
      
      if (resData.success && resData.timeline) {
        timelineData = resData.timeline;
        updateTimeStr = resData.update_time;
        
        dataStatus.textContent = `伺服器更新: ${updateTimeStr}`;
        
        // 1. Update timeline slider bounds dynamically
        maxTimelineIndex = timelineData.length - 1;
        timelineSlider.max = maxTimelineIndex;
        
        // Reset playback head to the end if out of bounds or paused
        if (currentTimelineIndex > maxTimelineIndex || !isPlaying) {
          currentTimelineIndex = maxTimelineIndex;
          timelineSlider.value = maxTimelineIndex;
        }

        // 2. Render ticks
        renderTimelineTicks();

        // 3. Render grid & overlays
        onTimelineSliderUpdate();

      } else {
        dataStatus.textContent = "更新失敗: API 傳回異常";
      }
    } catch (err) {
      console.error("無法載入氣象資料:", err);
      dataStatus.textContent = "更新失敗: 無法連接 API 伺服器";
    }
  }

  function renderTimelineTicks() {
    timelineTicksContainer.innerHTML = '';
    timelineData.forEach((slot, index) => {
      const tick = document.createElement('span');
      tick.className = 'timeline-tick-label';
      if (index === Math.floor(currentTimelineIndex)) {
        tick.classList.add('active');
      }
      tick.textContent = slot.label.split(" ")[1] || slot.label;
      
      tick.addEventListener('click', () => {
        timelineSlider.value = index;
        currentTimelineIndex = index;
        onTimelineSliderUpdate();
      });
      
      timelineTicksContainer.appendChild(tick);
    });
  }

  function updateQuickStats() {
    let tSum = 0, tCount = 0;
    let rSum = 0, rCount = 0;
    let wSum = 0, wCount = 0;

    weatherStations.forEach(s => {
      if (s.temp !== null) { tSum += s.temp; tCount++; }
      if (s.rain !== null) { rSum += s.rain; rCount++; }
      if (s.wind_speed !== null) { wSum += s.wind_speed; wCount++; }
    });

    valTemp.textContent = tCount > 0 ? (tSum / tCount).toFixed(1) + ' °C' : '-- °C';
    valRain.textContent = rCount > 0 ? (rSum / rCount).toFixed(1) + ' mm' : '-- mm';
    valWind.textContent = wCount > 0 ? (wSum / wCount).toFixed(1) + ' m/s' : '-- m/s';
  }

  // --- Layer Switches ---
  const layerBtns = document.querySelectorAll('.layer-btn');
  layerBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      layerBtns.forEach(b => b.classList.remove('active'));
      const targetBtn = e.currentTarget;
      targetBtn.classList.add('active');
      
      currentLayer = targetBtn.getAttribute('data-layer');
      
      drawGridToOffscreen(currentLayer);
      updateUIStats();
    });
  });

  // --- Playback State Helper ---
  function togglePlayState(play) {
    isPlaying = play;
    if (isPlaying) {
      btnPlayPause.textContent = '❚❚';
      btnPlayPause.style.background = 'var(--accent-color)';
      btnPlayPause.style.color = '#080a10';
      btnPlayPause.style.boxShadow = '0 0 18px var(--accent-color)';
    } else {
      btnPlayPause.textContent = '▶';
      btnPlayPause.style.background = 'rgba(0, 236, 255, 0.08)';
      btnPlayPause.style.color = 'var(--accent-color)';
      btnPlayPause.style.boxShadow = '0 0 10px rgba(0, 236, 255, 0.2)';
    }
  }

  // --- Play/Pause Slider Event Listeners ---
  timelineSlider.addEventListener('input', (e) => {
    currentTimelineIndex = parseFloat(e.target.value);
    onTimelineSliderUpdate();
  });

  btnPlayPause.addEventListener('click', () => {
    togglePlayState(!isPlaying);
  });

  btnDetailClose.addEventListener('click', () => {
    stationDetailPanel.style.display = 'none';
    selectedStationId = null;
  });

  btnRefresh.addEventListener('click', async () => {
    btnRefresh.classList.add('spinning');
    btnRefresh.disabled = true;
    
    dataStatus.textContent = "正在強制獲取最新資料...";
    
    // Refresh API call with parameter query string
    const refreshUrl = `/api/weather/refresh?date=${dateSelect.value}&hours=${rangeSelect.value}`;
    await fetchWeatherData(refreshUrl);
    
    setTimeout(() => {
      btnRefresh.classList.remove('spinning');
      btnRefresh.disabled = false;
    }, 1000);
  });

  // --- Entry Point ---
  initMap();
  initSelectors();
  initParticles();
  fetchWeatherData();
  renderLoop();
  
  // Refresh data every 5 minutes in background
  setInterval(() => {
    fetchWeatherData();
  }, 300000);
});
