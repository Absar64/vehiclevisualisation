/**
 * osm.js — real-world road data.
 *
 * Two public services, both queried straight from the browser:
 *
 *  - **OSRM** turns two pins into an actual driving route along real roads,
 *    which is what the road model then anticipates the bends of.
 *  - **Overpass** finds the traffic signals and speed cameras that genuinely
 *    exist along that route. The query is an `around:` over the route's own
 *    geometry rather than a bounding box, so a long or L-shaped route does not
 *    drag in every camera for miles either side of it.
 *
 * Both are shared community infrastructure with usage policies: they are fine
 * for a development tool driving a handful of requests, and would need a
 * self-hosted instance or a commercial key before anything ships. Every call
 * here is therefore deliberate — triggered by the operator pressing DRIVE, not
 * polled — and every failure degrades to "no data" rather than breaking the
 * scene.
 */

/**
 * Overpass mirrors, tried in order. The main instance is popular enough to
 * answer a burst of queries with a 504 or a rate limit, and a single endpoint
 * means one busy server is indistinguishable from "this road has no cameras".
 */
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
];
const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving';

/**
 * Neither service guarantees a reply. Overpass in particular will sit on a
 * heavy query — or a rate-limited one — indefinitely, which would leave the
 * simulator stuck on "Finding a route…" with no way back. Every request
 * therefore carries its own deadline.
 */
async function fetchWithTimeout(url, options = {}, ms = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('map service timed out');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Coordinates allowed in one Overpass `around:` clause. */
const MAX_PATH_POINTS = 180;

/**
 * Great Britain and Northern Ireland, generously boxed. Used to keep the
 * simulator inside the UK as specified — the box is deliberately loose at the
 * edges rather than a precise coastline, since its job is to reject Paris, not
 * to adjudicate the low-water mark.
 */
export const UK_BOUNDS = { south: 49.8, west: -8.65, north: 60.9, east: 1.78 };

export function isInUK({ lat, lon }) {
  return (
    lat >= UK_BOUNDS.south &&
    lat <= UK_BOUNDS.north &&
    lon >= UK_BOUNDS.west &&
    lon <= UK_BOUNDS.east
  );
}

/**
 * Drives OSRM for a road route between two points.
 *
 * @param {{lat:number, lon:number}} from
 * @param {{lat:number, lon:number}} to
 * @returns {Promise<{points:{lat:number,lon:number}[], distance:number}>}
 */
export async function fetchRoute(from, to) {
  const url =
    `${OSRM_URL}/${from.lon},${from.lat};${to.lon},${to.lat}` +
    '?overview=full&geometries=geojson';

  const response = await fetchWithTimeout(url, {}, 15_000);
  if (!response.ok) throw new Error(`routing service returned ${response.status}`);

  const data = await response.json();
  if (data.code !== 'Ok' || !data.routes?.length) {
    throw new Error('no drivable route between those points');
  }

  const route = data.routes[0];
  return {
    // GeoJSON is [lon, lat]; everything downstream wants {lat, lon}.
    points: route.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })),
    distance: route.distance,
  };
}

/**
 * Subsamples a route for use in an Overpass `around:` clause.
 *
 * OSRM returns a vertex every few metres, which would make a query tens of
 * thousands of characters long. One coordinate every ~120 m still covers the
 * road continuously once the radius is applied — and on a long route the
 * spacing is widened further, because query cost scales with the number of
 * coordinates and a cross-country drive would otherwise time the service out.
 */
function thin(points, minSpacing = 120) {
  if (points.length <= 2) return points;

  const kept = [points[0]];
  let last = points[0];
  for (const point of points) {
    const dLat = (point.lat - last.lat) * 111_320;
    const dLon = (point.lon - last.lon) * 111_320 * Math.cos(last.lat * (Math.PI / 180));
    if (Math.hypot(dLat, dLon) >= minSpacing) {
      kept.push(point);
      last = point;
    }
  }
  kept.push(points[points.length - 1]);
  return kept;
}

/**
 * Finds traffic signals and speed cameras along a route.
 *
 * Speed cameras are tagged inconsistently in OSM — `highway=speed_camera` is
 * the common one, but plenty are mapped as an enforcement device instead — so
 * both are asked for and merged.
 *
 * @param {{lat:number, lon:number}[]} points route geometry
 * @param {number} [radius] metres either side of the route to search
 * @returns {Promise<{type:'signal'|'camera', lat:number, lon:number}[]>}
 */
export async function fetchFurniture(points, radius = 25) {
  // Keep the coordinate list bounded however long the route is.
  const spacing = Math.max(120, (points.length * 12) / MAX_PATH_POINTS);
  const path = thin(points, spacing)
    .slice(0, MAX_PATH_POINTS)
    .map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`)
    .join(',');

  const query = `[out:json][timeout:25];
(
  node["highway"="traffic_signals"](around:${radius},${path});
  node["highway"="speed_camera"](around:${radius * 2},${path});
  node["enforcement"="maxspeed"](around:${radius * 2},${path});
);
out body 400;`;

  let data = null;
  let lastError = null;

  for (const url of OVERPASS_URLS) {
    try {
      const response = await fetchWithTimeout(url, { method: 'POST', body: query }, 25_000);
      if (!response.ok) throw new Error(`returned ${response.status}`);
      // Overpass answers errors and rate limits with an XML document and a 200,
      // so a failed parse here means "busy", not a broken response handler.
      data = await response.json();
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!data) {
    throw new Error(`map data service unavailable (${lastError?.message ?? 'no response'})`);
  }
  const seen = new Set();
  const items = [];

  for (const element of data.elements ?? []) {
    if (typeof element.lat !== 'number') continue;
    if (seen.has(element.id)) continue;
    seen.add(element.id);

    const tags = element.tags ?? {};
    const isCamera = tags.highway === 'speed_camera' || tags.enforcement === 'maxspeed';
    items.push({
      type: isCamera ? 'camera' : 'signal',
      lat: element.lat,
      lon: element.lon,
    });
  }

  return items;
}
