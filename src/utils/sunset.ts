// Pure JS sunset/sunrise calculation — no location permission required.
// Uses the device's IANA timezone to approximate latitude/longitude.

const TZ_COORDS: Record<string, { lat: number; lng: number }> = {
  'America/New_York':      { lat: 40.7,  lng: -74.0 },
  'America/Chicago':       { lat: 41.9,  lng: -87.6 },
  'America/Denver':        { lat: 39.7,  lng: -104.9 },
  'America/Phoenix':       { lat: 33.4,  lng: -112.1 },
  'America/Los_Angeles':   { lat: 34.1,  lng: -118.2 },
  'America/Anchorage':     { lat: 61.2,  lng: -149.9 },
  'America/Adak':          { lat: 51.9,  lng: -176.6 },
  'Pacific/Honolulu':      { lat: 21.3,  lng: -157.8 },
  'America/Toronto':       { lat: 43.7,  lng: -79.4 },
  'America/Vancouver':     { lat: 49.3,  lng: -123.1 },
  'America/Edmonton':      { lat: 53.5,  lng: -113.5 },
  'America/Winnipeg':      { lat: 49.9,  lng: -97.1 },
  'America/Halifax':       { lat: 44.6,  lng: -63.6 },
  'America/St_Johns':      { lat: 47.6,  lng: -52.7 },
  'America/Sao_Paulo':     { lat: -23.5, lng: -46.6 },
  'America/Mexico_City':   { lat: 19.4,  lng: -99.1 },
  'America/Bogota':        { lat: 4.7,   lng: -74.1 },
  'America/Lima':          { lat: -12.0, lng: -77.0 },
  'America/Buenos_Aires':  { lat: -34.6, lng: -58.4 },
  'Europe/London':         { lat: 51.5,  lng: -0.1 },
  'Europe/Paris':          { lat: 48.9,  lng: 2.4 },
  'Europe/Berlin':         { lat: 52.5,  lng: 13.4 },
  'Europe/Madrid':         { lat: 40.4,  lng: -3.7 },
  'Europe/Rome':           { lat: 41.9,  lng: 12.5 },
  'Europe/Amsterdam':      { lat: 52.4,  lng: 4.9 },
  'Europe/Stockholm':      { lat: 59.3,  lng: 18.1 },
  'Europe/Oslo':           { lat: 59.9,  lng: 10.7 },
  'Europe/Helsinki':       { lat: 60.2,  lng: 25.0 },
  'Europe/Athens':         { lat: 37.9,  lng: 23.7 },
  'Europe/Warsaw':         { lat: 52.2,  lng: 21.0 },
  'Europe/Moscow':         { lat: 55.8,  lng: 37.6 },
  'Asia/Dubai':            { lat: 25.2,  lng: 55.3 },
  'Asia/Karachi':          { lat: 24.9,  lng: 67.0 },
  'Asia/Kolkata':          { lat: 28.6,  lng: 77.2 },
  'Asia/Bangkok':          { lat: 13.8,  lng: 100.5 },
  'Asia/Shanghai':         { lat: 31.2,  lng: 121.5 },
  'Asia/Tokyo':            { lat: 35.7,  lng: 139.7 },
  'Asia/Seoul':            { lat: 37.6,  lng: 127.0 },
  'Asia/Singapore':        { lat: 1.3,   lng: 103.8 },
  'Asia/Jakarta':          { lat: -6.2,  lng: 106.8 },
  'Australia/Sydney':      { lat: -33.9, lng: 151.2 },
  'Australia/Melbourne':   { lat: -37.8, lng: 145.0 },
  'Australia/Brisbane':    { lat: -27.5, lng: 153.0 },
  'Australia/Perth':       { lat: -31.9, lng: 115.9 },
  'Pacific/Auckland':      { lat: -36.9, lng: 174.8 },
  'Africa/Johannesburg':   { lat: -26.2, lng: 28.0 },
  'Africa/Cairo':          { lat: 30.1,  lng: 31.2 },
  'Africa/Lagos':          { lat: 6.5,   lng: 3.4 },
};

function toRad(deg: number) { return (deg * Math.PI) / 180; }
function toDeg(rad: number) { return (rad * 180) / Math.PI; }

function getCoords(): { lat: number; lng: number } {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (TZ_COORDS[tz]) return TZ_COORDS[tz];

  // Fallback: derive longitude from UTC offset
  const offsetMin = -new Date().getTimezoneOffset();
  return { lat: 40, lng: (offsetMin / 60) * 15 };
}

export function getSunriseSunset(date: Date = new Date()): { sunrise: Date; sunset: Date } {
  const { lat, lng } = getCoords();

  // Day of year
  const start = new Date(date.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((date.getTime() - start.getTime()) / 86400000);

  // Solar declination (degrees)
  const declination = 23.45 * Math.sin(toRad((360 / 365) * (dayOfYear - 81)));

  // Hour angle at sunrise/sunset
  const cosHourAngle = -Math.tan(toRad(lat)) * Math.tan(toRad(declination));

  // Polar day/night edge cases
  if (cosHourAngle < -1) {
    // Midnight sun — always light; return wide window
    const rise = new Date(date); rise.setHours(3, 0, 0, 0);
    const set = new Date(date); set.setHours(23, 59, 0, 0);
    return { sunrise: rise, sunset: set };
  }
  if (cosHourAngle > 1) {
    // Polar night — always dark; collapse window
    const rise = new Date(date); rise.setHours(12, 0, 0, 0);
    const set = new Date(date); set.setHours(12, 1, 0, 0);
    return { sunrise: rise, sunset: set };
  }

  const hourAngle = toDeg(Math.acos(cosHourAngle)); // degrees

  // Equation of time correction (minutes)
  const B = toRad((360 / 365) * (dayOfYear - 81));
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);

  // UTC offset in minutes
  const tzOffsetMin = -date.getTimezoneOffset();

  // Solar noon in local hours
  const solarNoon = (720 - eot - (lng - tzOffsetMin / 4)) / 60;

  const sunriseHrs = solarNoon - hourAngle / 15;
  const sunsetHrs  = solarNoon + hourAngle / 15;

  function hrsToDate(hrs: number): Date {
    const d = new Date(date);
    const h = Math.floor(hrs);
    const m = Math.round((hrs - h) * 60);
    d.setHours(h, m, 0, 0);
    return d;
  }

  return { sunrise: hrsToDate(sunriseHrs), sunset: hrsToDate(sunsetHrs) };
}

export function isNighttime(): boolean {
  const now = new Date();
  const { sunrise, sunset } = getSunriseSunset(now);
  return now < sunrise || now > sunset;
}
