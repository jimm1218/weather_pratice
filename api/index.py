import os
import json
import sqlite3
import datetime
import requests
import math  # 用於模擬歷史波動
from flask import Flask, jsonify, send_from_directory, request

app = Flask(__name__)

# 獲取專案根目錄 (api/ 檔案的上一層)
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 手動載入 .env 檔案
def load_env():
    env_path = os.path.join(ROOT_DIR, '.env')
    if os.path.exists(env_path):
        with open(env_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, val = line.split('=', 1)
                    os.environ[key.strip()] = val.strip()

load_env()

API_KEY = os.environ.get('CWB_API_KEY', '')
CWA_API_URL = "https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0001-001"

# Vercel 唯讀環境相容性處理：若在 Vercel 運行，將快取寫入可寫入的 /tmp 目錄
if os.environ.get('VERCEL'):
    JSON_CACHE_PATH = '/tmp/cwa_observation.json'
    DB_PATH = '/tmp/cwa_observation.db'
    
    # 若 /tmp 中沒有初始的快取，但專案目錄下有，先拷貝過去以避免首次載入無資料
    local_json = os.path.join(ROOT_DIR, 'cwa_observation.json')
    local_db = os.path.join(ROOT_DIR, 'cwa_observation.db')
    if not os.path.exists(JSON_CACHE_PATH) and os.path.exists(local_json):
        import shutil
        try:
            shutil.copy(local_json, JSON_CACHE_PATH)
        except Exception:
            pass
    if not os.path.exists(DB_PATH) and os.path.exists(local_db):
        import shutil
        try:
            shutil.copy(local_db, DB_PATH)
        except Exception:
            pass
else:
    JSON_CACHE_PATH = os.path.join(ROOT_DIR, 'cwa_observation.json')
    DB_PATH = os.path.join(ROOT_DIR, 'cwa_observation.db')

# 輔支：安全轉換數值
def safe_float(val, default=None):
    try:
        f = float(val)
        if f == -99.0 or f == -99:
            return default
        return f
    except (ValueError, TypeError):
        return default

# 輔助：升級舊版資料庫與更新 SQLite 資料庫
def update_sqlite_db(stations):
    # 檢查是否需要升級舊版資料庫 (若舊表 station_id 欄位是單一 UNIQUE 限制，不含 obs_time)
    if os.path.exists(DB_PATH):
        try:
            conn = sqlite3.connect(DB_PATH)
            cursor = conn.cursor()
            cursor.execute("SELECT sql FROM sqlite_master WHERE name='cwa_observations'")
            row = cursor.fetchone()
            if row and "UNIQUE" in row[0] and "obs_time" not in row[0]:
                print("偵測到舊版資料庫 Schema，正在刪除以升級為多時段複合唯一鍵 (station_id, obs_time)...")
                cursor.execute("DROP TABLE cwa_observations")
                conn.commit()
            conn.close()
        except Exception as e:
            print(f"資料庫 schema 升級檢查失敗: {e}")

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS cwa_observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            station_name TEXT,
            station_id TEXT,
            obs_time TEXT,
            weather TEXT,
            precipitation TEXT,
            wind_direction TEXT,
            wind_speed TEXT,
            air_temperature TEXT,
            relative_humidity TEXT,
            air_pressure TEXT,
            peak_gust_speed TEXT,
            station_altitude TEXT,
            county_name TEXT,
            town_name TEXT,
            county_code TEXT,
            town_code TEXT,
            station_latitude_twd67 TEXT,
            station_longitude_twd67 TEXT,
            station_latitude_wgs84 TEXT,
            station_longitude_wgs84 TEXT,
            daily_high_temperature TEXT,
            daily_high_time TEXT,
            daily_low_temperature TEXT,
            daily_low_time TEXT,
            UNIQUE(station_id, obs_time)
        )
    ''')
    conn.commit()

    for station in stations:
        try:
            s_name = station.get('StationName', '')
            s_id = station.get('StationId', '')
            obs_time = station.get('ObsTime', {}).get('DateTime', '')
            
            geo = station.get('GeoInfo', {})
            coord_wgs84 = {}
            coord_twd67 = {}
            for coord in geo.get('Coordinates', []):
                if coord.get('CoordinateName') == 'WGS84':
                    coord_wgs84 = coord
                elif coord.get('CoordinateName') == 'TWD67':
                    coord_twd67 = coord
            
            if not coord_wgs84 and geo.get('Coordinates'):
                coord_wgs84 = geo['Coordinates'][0]

            lat_wgs84 = coord_wgs84.get('StationLatitude', '')
            lon_wgs84 = coord_wgs84.get('StationLongitude', '')
            lat_twd67 = coord_twd67.get('StationLatitude', '')
            lon_twd67 = coord_twd67.get('StationLongitude', '')
            
            alt = geo.get('StationAltitude', '')
            county = geo.get('CountyName', '')
            town = geo.get('TownName', '')
            county_code = geo.get('CountyCode', '')
            town_code = geo.get('TownCode', '')
            
            elem = station.get('WeatherElement', {})
            weather = elem.get('Weather', '')
            precip = elem.get('Now', {}).get('Precipitation', '')
            wind_dir = elem.get('WindDirection', '')
            wind_speed = elem.get('WindSpeed', '')
            temp = elem.get('AirTemperature', '')
            humidity = elem.get('RelativeHumidity', '')
            pressure = elem.get('AirPressure', '')
            gust = elem.get('GustInfo', {}).get('PeakGustSpeed', '')
            
            extreme = elem.get('DailyExtreme', {})
            high_temp = extreme.get('DailyHigh', {}).get('TemperatureInfo', {}).get('AirTemperature', '')
            high_time = extreme.get('DailyHigh', {}).get('TemperatureInfo', {}).get('Occurred_at', {}).get('DateTime', '')
            low_temp = extreme.get('DailyLow', {}).get('TemperatureInfo', {}).get('AirTemperature', '')
            low_time = extreme.get('DailyLow', {}).get('TemperatureInfo', {}).get('Occurred_at', {}).get('DateTime', '')

            cursor.execute("SELECT id FROM cwa_observations WHERE station_id = ? AND obs_time = ?", (s_id, obs_time))
            row = cursor.fetchone()
            if row:
                cursor.execute('''
                    UPDATE cwa_observations SET
                        station_name = ?, weather = ?, precipitation = ?, wind_direction = ?, 
                        wind_speed = ?, air_temperature = ?, relative_humidity = ?, air_pressure = ?, 
                        peak_gust_speed = ?, station_altitude = ?, county_name = ?, town_name = ?, 
                        county_code = ?, town_code = ?, station_latitude_twd67 = ?, station_longitude_twd67 = ?, 
                        station_latitude_wgs84 = ?, station_longitude_wgs84 = ?, daily_high_temperature = ?, 
                        daily_high_time = ?, daily_low_temperature = ?, daily_low_time = ?
                    WHERE station_id = ? AND obs_time = ?
                ''', (
                    s_name, weather, precip, wind_dir, wind_speed, temp, humidity, pressure,
                    gust, alt, county, town, county_code, town_code, lat_twd67, lon_twd67, lat_wgs84, lon_wgs84,
                    high_temp, high_time, low_temp, low_time, s_id, obs_time
                ))
            else:
                cursor.execute('''
                    INSERT INTO cwa_observations (
                        station_name, station_id, obs_time, weather, precipitation, wind_direction, 
                        wind_speed, air_temperature, relative_humidity, air_pressure, peak_gust_speed, 
                        station_altitude, county_name, town_name, county_code, town_code, 
                        station_latitude_twd67, station_longitude_twd67, station_latitude_wgs84, 
                        station_longitude_wgs84, daily_high_temperature, daily_high_time, 
                        daily_low_temperature, daily_low_time
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''', (
                    s_name, s_id, obs_time, weather, precip, wind_dir, wind_speed, temp, humidity, pressure,
                    gust, alt, county, town, county_code, town_code, lat_twd67, lon_twd67, lat_wgs84, lon_wgs84,
                    high_temp, high_time, low_temp, low_time
                ))
        except Exception as ex:
            print(f"寫入資料庫失敗 (StationId: {station.get('StationId')}): {ex}")
    
    conn.commit()
    conn.close()

# 核心邏輯：獲取氣象觀測資料
def fetch_weather_data():
    need_fetch = True
    
    if os.path.exists(JSON_CACHE_PATH):
        mtime = datetime.datetime.fromtimestamp(os.path.getmtime(JSON_CACHE_PATH))
        now = datetime.datetime.now()
        if (now - mtime).total_seconds() < 1800:
            need_fetch = False
            print("使用本地快取 cwa_observation.json 資料...")

    if need_fetch and API_KEY:
        print(f"向 CWA API 請求最新氣象資料... (Key: {API_KEY[:6]}***)")
        try:
            import urllib3
            urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
            params = {
                "Authorization": API_KEY,
                "format": "JSON"
            }
            res = requests.get(CWA_API_URL, params=params, timeout=15, verify=False)
            if res.status_code == 200:
                data = res.json()
                if data.get('success') == 'true' or data.get('success') is True:
                    with open(JSON_CACHE_PATH, 'w', encoding='utf-8') as f:
                        json.dump(data, f, ensure_ascii=False, indent=2)
                    
                    stations = data.get('records', {}).get('Station', [])
                    update_sqlite_db(stations)
                    print(f"成功更新快取與資料庫，共計 {len(stations)} 站。")
                else:
                    print("CWA API 傳回 success=false，使用本地快取。")
            else:
                print(f"CWA API 請求失敗，HTTP 狀態碼: {res.status_code}，使用本地快取。")
        except Exception as e:
            print(f"呼叫 CWA API 發生異常: {e}，將使用本地快取。")
    
    if os.path.exists(JSON_CACHE_PATH):
        try:
            with open(JSON_CACHE_PATH, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"讀取 cwa_observation.json 快取失敗: {e}")
            
    return None

# 整理並過濾乾淨的測站資訊給前端
def get_clean_station_data(raw_data):
    if not raw_data:
        return []
    
    stations = raw_data.get('records', {}).get('Station', [])
    clean_list = []
    
    for s in stations:
        geo = s.get('GeoInfo', {})
        coords = geo.get('Coordinates', [])
        
        lat, lon = None, None
        for c in coords:
            if c.get('CoordinateName') == 'WGS84':
                lat = safe_float(c.get('StationLatitude'))
                lon = safe_float(c.get('StationLongitude'))
                break
        
        if lat is None or lon is None:
            if coords:
                lat = safe_float(coords[0].get('StationLatitude'))
                lon = safe_float(coords[0].get('StationLongitude'))
        
        if lat is None or lon is None:
            continue
            
        elem = s.get('WeatherElement', {})
        precip = safe_float(elem.get('Now', {}).get('Precipitation'), default=0.0)
        if precip is not None and precip < 0:
            precip = 0.0
            
        temp = safe_float(elem.get('AirTemperature'))
        wind_dir = safe_float(elem.get('WindDirection'))
        wind_speed = safe_float(elem.get('WindSpeed'))
        humidity = safe_float(elem.get('RelativeHumidity'))
        pressure = safe_float(elem.get('AirPressure'))
        
        clean_list.append({
            "station_name": s.get('StationName', ''),
            "station_id": s.get('StationId', ''),
            "obs_time": s.get('ObsTime', {}).get('DateTime', ''),
            "lat": lat,
            "lon": lon,
            "weather": elem.get('Weather', '未知'),
            "temp": temp,
            "rain": precip,
            "wind_dir": wind_dir,
            "wind_speed": wind_speed,
            "humidity": humidity,
            "pressure": pressure,
            "county": geo.get('CountyName', ''),
            "town": geo.get('TownName', '')
        })
        
    return clean_list

# 核心邏輯：生成模擬的時間區間觀測（T-N小時 到 T最新）
def generate_simulated_timeline(latest_clean_data, date_str=None, hours=6):
    if not latest_clean_data:
        return []
    
    base_time = None
    if date_str:
        try:
            today_str = datetime.date.today().strftime('%Y-%m-%d')
            if date_str == today_str:
                base_time = datetime.datetime.fromisoformat(latest_clean_data[0]['obs_time'])
            else:
                base_time = datetime.datetime.strptime(date_str, '%Y-%m-%d').replace(hour=23, minute=0, second=0)
        except Exception:
            pass
            
    if base_time is None:
        try:
            base_time = datetime.datetime.fromisoformat(latest_clean_data[0]['obs_time'])
        except Exception:
            base_time = datetime.datetime.now()

    timeline = []
    
    for i in range(-(hours - 1), 1):
        offset_time = base_time + datetime.timedelta(hours=i)
        time_label = offset_time.strftime('%m/%d %H:%M')
        if i == 0:
            time_label += " (最新)"
            
        iso_time = offset_time.isoformat()
        
        offset_data = []
        for s in latest_clean_data:
            new_s = s.copy()
            new_s['obs_time'] = iso_time
            
            # --- 模擬波動與氣象系統移動 ---
            hour_of_day = offset_time.hour
            temp_wave = 2.8 * math.sin((hour_of_day - 8) * math.pi / 12)
            if s['temp'] is not None:
                new_s['temp'] = round(s['temp'] + temp_wave, 1)

            progress = (i + (hours - 1)) / (hours - 1) if (hours - 1) > 0 else 1.0

            rotation = progress * 160.0
            if s['wind_dir'] is not None:
                new_s['wind_dir'] = round((s['wind_dir'] + rotation) % 360, 1)
            else:
                new_s['wind_dir'] = round(rotation, 1)

            wind_base = 2.0 + 4.0 * math.sin(progress * math.pi)
            local_wind_var = 2.0 * math.sin(s['lat'] * 6.0 + s['lon'] * 6.0)
            new_s['wind_speed'] = max(0.5, round(wind_base + local_wind_var, 1))

            front_lat = 25.3 - (progress * 3.5)
            dist = math.sqrt((s['lat'] - front_lat)**2 + (s['lon'] - 121.0)**2)
            rain_val = max(0.0, 28.0 - dist * 22.0)
            
            noise = 2.5 * math.sin(s['lat'] * 12.0 + s['lon'] * 8.0 + (i * 1.5))
            if rain_val > 0:
                new_s['rain'] = round(max(0.0, rain_val + noise), 1)
            else:
                new_s['rain'] = 0.0

            offset_data.append(new_s)
            
        timeline.append({
            "label": time_label,
            "timestamp": iso_time,
            "data": offset_data
        })
        
    return timeline

# 核心邏輯：整合資料庫歷史紀錄與模擬時間軸
def generate_timeline_data(latest_clean_data, date_str=None, hours=6):
    if not os.path.exists(DB_PATH) or not latest_clean_data:
        return generate_simulated_timeline(latest_clean_data, date_str, hours)
        
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        
        if date_str:
            like_pattern = f"{date_str}%"
            cursor.execute("SELECT DISTINCT obs_time FROM cwa_observations WHERE obs_time LIKE ? ORDER BY obs_time DESC LIMIT ?", (like_pattern, hours))
        else:
            cursor.execute("SELECT DISTINCT obs_time FROM cwa_observations ORDER BY obs_time DESC LIMIT ?", (hours,))
            
        rows = cursor.fetchall()
        unique_times = [r[0] for r in rows]
        unique_times.reverse()
        
        if len(unique_times) < 2:
            conn.close()
            return generate_simulated_timeline(latest_clean_data, date_str, hours)

        timeline = []
        for t in unique_times:
            cursor.execute("SELECT * FROM cwa_observations WHERE obs_time = ?", (t,))
            db_stations = []
            
            for row in cursor.fetchall():
                db_stations.append({
                    "station_name": row[1],
                    "station_id": row[2],
                    "obs_time": row[3],
                    "weather": row[4],
                    "rain": safe_float(row[5], default=0.0),
                    "wind_dir": safe_float(row[6]),
                    "wind_speed": safe_float(row[7]),
                    "temp": safe_float(row[8]),
                    "humidity": safe_float(row[9]),
                    "pressure": safe_float(row[10]),
                    "county": row[13],
                    "town": row[14],
                    "lat": safe_float(row[19]),
                    "lon": safe_float(row[20])
                })
            
            try:
                dt = datetime.datetime.fromisoformat(t)
                lbl = dt.strftime('%m/%d %H:%M')
            except:
                lbl = t
                
            if t == unique_times[-1]:
                lbl += " (最新)"
                
            timeline.append({
                "label": lbl,
                "timestamp": t,
                "data": db_stations
            })
            
        conn.close()
        return timeline
    except Exception as ex:
        print(f"從資料庫獲取時間軸失敗: {ex}，降級使用模擬時間軸")
        return generate_simulated_timeline(latest_clean_data, date_str, hours)

# API: 獲取氣象測站清單與時間軸
@app.route('/api/weather', methods=['GET'])
def api_weather():
    date_param = request.args.get('date')
    hours_param = request.args.get('hours', default=6, type=int)
    hours_param = max(3, min(24, hours_param))
    
    raw_data = fetch_weather_data()
    clean_data = get_clean_station_data(raw_data)
    
    update_time = "未知"
    if os.path.exists(JSON_CACHE_PATH):
        mtime = datetime.datetime.fromtimestamp(os.path.getmtime(JSON_CACHE_PATH))
        update_time = mtime.strftime('%Y-%m-%d %H:%M:%S')

    timeline = generate_timeline_data(clean_data, date_param, hours_param)

    return jsonify({
        "success": True,
        "update_time": update_time,
        "count": len(clean_data),
        "timeline": timeline
    })

# API: 強制重新抓取 CWA 最新資料
@app.route('/api/weather/refresh', methods=['POST'])
def api_refresh():
    date_param = request.args.get('date')
    hours_param = request.args.get('hours', default=6, type=int)
    hours_param = max(3, min(24, hours_param))

    if not API_KEY:
        return jsonify({"success": False, "message": "未設定 CWB_API_KEY，無法強制抓取最新資料。"})
    
    if os.path.exists(JSON_CACHE_PATH):
        try:
            os.remove(JSON_CACHE_PATH)
        except Exception as e:
            return jsonify({"success": False, "message": f"刪除快取失敗: {e}"})
            
    raw_data = fetch_weather_data()
    clean_data = get_clean_station_data(raw_data)
    
    update_time = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    timeline = generate_timeline_data(clean_data, date_param, hours_param)
    
    return jsonify({
        "success": True,
        "update_time": update_time,
        "count": len(clean_data),
        "timeline": timeline
    })

# 路由：主網頁
@app.route('/')
def route_index():
    return send_from_directory(ROOT_DIR, 'index.html')

# 路由：CSS
@app.route('/style.css')
def route_css():
    return send_from_directory(ROOT_DIR, 'style.css')

# 路由：JavaScript
@app.route('/script.js')
def route_js():
    return send_from_directory(ROOT_DIR, 'script.js')

if __name__ == '__main__':
    try:
        fetch_weather_data()
    except Exception as e:
        print(f"啟動時快取資料失敗: {e}")
        
    app.run(host='127.0.0.1', port=8000, debug=True)
