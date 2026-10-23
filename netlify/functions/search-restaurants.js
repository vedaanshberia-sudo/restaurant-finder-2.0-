
const fs = require("fs");
const path = require("path");

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const json = (statusCode, body) => ({
  statusCode,
  headers,
  body: JSON.stringify(body)
});

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = n => n * Math.PI / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) *
    Math.cos(rad(lat2)) *
    Math.sin(dLon / 2) ** 2;

  return 6371 * 2 * Math.atan2(
    Math.sqrt(a),
    Math.sqrt(Math.max(0, 1 - a))
  );
}

// Parse CSV correctly, including quoted values containing commas.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  if (!rows.length) return [];

  const columns = rows[0].map(value => value.trim());

  return rows.slice(1)
    .filter(values => values.some(value => value.trim() !== ""))
    .map(values => {
      const item = {};
      columns.forEach((column, index) => {
        item[column] = (values[index] || "").trim();
      });
      return item;
    });
}

let zomatoCache = null;
let zomatoLoadAttempted = false;

function loadZomatoData() {
  if (zomatoLoadAttempted) return zomatoCache || [];

  zomatoLoadAttempted = true;

  try {
    const filePath = path.join(
      process.cwd(),
      "data",
      "zomato_clean.csv"
    );

    const content = fs.readFileSync(filePath, "utf8");
    zomatoCache = parseCSV(content);
    return zomatoCache;
  } catch (error) {
    console.error("Could not load Zomato dataset:", error.message);
    return [];
  }
}

function validCoordinate(lat, lon) {
  return Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= 6 &&
    lat <= 37.5 &&
    lon >= 68 &&
    lon <= 98.5 &&
    lat !== 0 &&
    lon !== 0;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getZomatoMatch(name, city, lat, lon, records) {
  const wantedName = normalize(name);
  const wantedCity = normalize(city);

  if (!wantedName || !wantedCity) return null;

  const candidates = records.filter(record => {
    if (normalize(record.restaurant_name) !== wantedName) {
      return false;
    }

    if (normalize(record.city) !== wantedCity) {
      return false;
    }

    const dataLat = numberOrNull(record.latitude);
    const dataLon = numberOrNull(record.longitude);

    // When dataset coordinates exist, reject distant same-name places.
    if (validCoordinate(dataLat, dataLon)) {
      return distanceKm(lat, lon, dataLat, dataLon) <= 5;
    }

    // Without coordinates, only the exact normalized name and city
    // can be used. This is a weaker match.
    return true;
  });

  if (!candidates.length) return null;

  // Prefer the closest coordinate match when coordinates are available.
  candidates.sort((a, b) => {
    const aLat = numberOrNull(a.latitude);
    const aLon = numberOrNull(a.longitude);
    const bLat = numberOrNull(b.latitude);
    const bLon = numberOrNull(b.longitude);

    const aValid = validCoordinate(aLat, aLon);
    const bValid = validCoordinate(bLat, bLon);

    if (aValid && bValid) {
      return distanceKm(lat, lon, aLat, aLon) -
        distanceKm(lat, lon, bLat, bLon);
    }

    return Number(b.votes || 0) - Number(a.votes || 0);
  });

  return candidates[0];
}

function kindOf(tags) {
  if (tags.amenity === "cafe") return "Café";
  if (tags.amenity === "restaurant") return "Restaurant";
  if (tags.amenity === "fast_food") return "Fast food";
  if (tags.amenity === "food_court") return "Food court";

  if (tags.amenity === "ice_cream" ||
      tags.shop === "ice_cream") {
    return "Ice cream";
  }

  if (tags.shop === "bakery" || tags.shop === "pastry") {
    return "Bakery";
  }

  if (tags.shop === "confectionery") return "Dessert shop";

  return "Food place";
}

function scorePlace(tags, prefs, distance, zomato) {
  let score = 0;
  const reasons = [];
  const searchable = normalize([
    tags.cuisine,
    tags.name,
    tags.amenity,
    tags.shop,
    tags.brand,
    zomato?.cuisines
  ].filter(Boolean).join(" "));

  const kind = kindOf(tags);

  // Give cafés a small preference.
  if (tags.amenity === "cafe") {
    score += 3;
    reasons.push("Café");
  }

  const cuisines = (prefs.cuisine || [])
    .filter(item => item !== "Any cuisine");

  const cuisineMatches = cuisines.filter(item =>
    searchable.includes(normalize(item))
  );

  if (cuisineMatches.length) {
    score += cuisineMatches.length * 6;
    reasons.push("Cuisine: " + cuisineMatches.join(", "));
  }

  const selectedPlaces = prefs.places || [];

  const placeMatches = selectedPlaces.filter(item => {
    if (item === "Vegetarian place") {
      return tags["diet:vegetarian"] === "yes";
    }

    if (item === "Dessert shop") {
      return kind === "Dessert shop" ||
        kind === "Ice cream" ||
        /dessert|cake|sweet|ice cream|confectionery/.test(searchable);
    }

    if (item === "Café") return tags.amenity === "cafe";
    if (item === "Restaurant") return tags.amenity === "restaurant";
    if (item === "Fast food") return tags.amenity === "fast_food";
    if (item === "Food court") return tags.amenity === "food_court";

    if (item === "Bakery") {
      return kind === "Bakery" || kind === "Dessert shop";
    }

    return normalize(kind).includes(normalize(item));
  });

  if (placeMatches.length) {
    score += placeMatches.length * 5;
    reasons.push("Place type match");
  }

  const dietTagMap = {
    "Vegetarian": tags["diet:vegetarian"],
    "Vegan": tags["diet:vegan"],
    "Jain": tags["diet:jain"],
    "Halal": tags["diet:halal"],
    "Gluten-free": tags["diet:gluten_free"],
    "Dairy-free": tags["diet:dairy_free"]
  };

  const diets = prefs.diet || [];

  const knownSuitable = diets.filter(
    item => dietTagMap[item] === "yes"
  );

  if (knownSuitable.length) {
    score += knownSuitable.length * 4;
    reasons.push("Diet tags: " + knownSuitable.join(", "));
  }

  const knownUnsuitable = diets.filter(
    item => dietTagMap[item] === "no"
  );

  score -= knownUnsuitable.length * 10;

  const radiusKm = Math.max(
    1,
    Math.min(20, Number(prefs.radius || 5000) / 1000)
  );

  score += Math.max(0, 4 - (distance / radiusKm) * 4);

  if (prefs.priority === "distance") {
    score += Math.max(0, 8 - distance);
  }

  const rating = numberOrNull(zomato?.aggregate_rating) ??
    numberOrNull(tags.stars);

  if (prefs.priority === "rating" && rating !== null &&
      rating >= 0 && rating <= 5) {
    score += rating * 2;
  }

  if (prefs.priority === "value") {
    const cost = numberOrNull(zomato?.average_cost_for_two_inr);

    if (cost !== null && cost > 0 && cost <= 500) {
      score += 5;
    } else if (cost !== null && cost <= 1000) {
      score += 2;
    }
  }

  if (prefs.priority === "match" && reasons.length > 0) {
    score += 2;
  }

  return {
    score,
    matchReason: reasons.length
      ? reasons.slice(0, 2).join(" · ")
      : "Nearby option"
  };
}

exports.handler = async event => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return json(405, {
      error: "Use POST for restaurant searches."
    });
  }

  let input;

  try {
    input = JSON.parse(event.body || "{}");
  } catch {
    return json(400, {
      error: "Invalid search request. Please refresh and try again."
    });
  }

  const location = input.location || {};
  const city = String(location.city || "").trim();
  const state = String(location.state || "").trim();
  const road = String(location.road || "").trim();

  if (
    !city ||
    !state ||
    !road ||
    String(location.country || "").toLowerCase() !== "india"
  ) {
    return json(400, {
      error: "First verify and save your Indian city, state, and road or locality."
    });
  }

  const lat = Number(location.lat);
  const lon = Number(location.lon);

  if (!validCoordinate(lat, lon)) {
    return json(400, {
      error: "Your saved location is invalid. Verify and save it again."
    });
  }

  const radius = Math.max(
    1000,
    Math.min(20000, Number(input.radius) || 5000)
  );

  // Read the Zomato dataset. If unavailable, OpenStreetMap still works.
  const zomatoRecords = loadZomatoData();

  const query = `
    [out:json][timeout:25];
    (
      nwr(around:${radius},${lat},${lon})
        ["amenity"~"^(restaurant|cafe|fast_food|food_court|ice_cream)$"];
      nwr(around:${radius},${lat},${lon})
        ["shop"~"^(bakery|pastry|confectionery|ice_cream)$"];
    );
    out center tags;
  `;

  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter"
  ];

  let elements = null;

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": "NearBitesIndia/1.0",
          "Accept": "application/json"
        },
        body: "data=" + encodeURIComponent(query)
      });

      if (!response.ok) continue;

      const result = await response.json();

      if (Array.isArray(result.elements)) {
        elements = result.elements;
        break;
      }
    } catch (error) {
      console.error("OpenStreetMap endpoint failed:", error.message);
    }
  }

  if (elements === null) {
    return json(503, {
      error: "The free map service is busy. Please wait a moment and try again."
    });
  }

  const seen = new Set();
  const places = [];

  for (const element of elements) {
    const tags = element.tags || {};
    const name = String(tags.name || "").trim();

    const placeLat = Number(element.lat ?? element.center?.lat);
    const placeLon = Number(element.lon ?? element.center?.lon);

    if (
      !name ||
      !Number.isFinite(placeLat) ||
      !Number.isFinite(placeLon)
    ) {
      continue;
    }

    const key = `${element.type}/${element.id}`;

    if (seen.has(key)) continue;
    seen.add(key);

    const distance = distanceKm(lat, lon, placeLat, placeLon);

    if (distance * 1000 > radius) continue;

    // Match by exact normalized restaurant name and city.
    // When both sets of coordinates exist, require proximity too.
    const zomato = getZomatoMatch(
      name,
      city,
      placeLat,
      placeLon,
      zomatoRecords
    );

    const result = scorePlace(tags, input, distance, zomato);

    const address = [
      tags["addr:housenumber"],
      tags["addr:street"],
      tags["addr:suburb"] ||
        tags["addr:neighbourhood"] ||
        tags["addr:city"]
    ].filter(Boolean).join(" ");

    const osmCuisine = String(tags.cuisine || "")
      .split(";")
      .map(item => item.trim())
      .filter(Boolean)
      .map(item => item.replace(/\b\w/g, char => char.toUpperCase()))
      .join(", ");

    const zomatoRating = numberOrNull(zomato?.aggregate_rating);
    const osmRating = numberOrNull(tags.stars);

    const safeZomatoRating =
      zomatoRating !== null && zomatoRating >= 0 && zomatoRating <= 5
        ? zomatoRating
        : null;

    const safeOsmRating =
      osmRating !== null && osmRating >= 0 && osmRating <= 5
        ? osmRating
        : null;

    const averageCost = numberOrNull(
      zomato?.average_cost_for_two_inr
    );

    const cuisines = String(zomato?.cuisines || "")
      .split(";")
      .map(item => item.trim())
      .filter(Boolean)
      .join(", ");

    places.push({
      name,
      distanceKm: Math.round(distance * 100) / 100,
      distanceLabel: distance < 1
        ? `${Math.round(distance * 1000)} m`
        : `${distance.toFixed(1)} km`,
      address,
      cuisine: osmCuisine || cuisines,
      kind: kindOf(tags),
      diet: tags["diet:vegetarian"] === "yes"
        ? "Vegetarian options tagged"
        : "",
      rating: safeZomatoRating ?? safeOsmRating,
      ratingSource: safeZomatoRating !== null
        ? "Zomato dataset"
        : safeOsmRating !== null
          ? "OpenStreetMap"
          : null,
      price: averageCost !== null && averageCost > 0
        ? `₹${Math.round(averageCost)} for two`
        : tags.price || null,
      averageCostForTwo: averageCost,
      zomatoRating: safeZomatoRating,
      zomatoVotes: numberOrNull(zomato?.votes),
      dataSource: zomato
        ? "OpenStreetMap + Zomato dataset"
        : "OpenStreetMap",
      score: result.score,
      matchReason: result.matchReason,
      mapUrl:
        `https://www.openstreetmap.org/?mlat=${placeLat}&mlon=${placeLon}#map=18/${placeLat}/${placeLon}`
    });
  }

  places.sort((a, b) =>
    b.score - a.score || a.distanceKm - b.distanceKm
  );

  const selected = places.slice(0, 12);

  let note = "";

  if (places.length === 0) {
    note =
      "No named food places were found in this map data for the selected area. Try a larger distance or another nearby locality.";
  } else if (zomatoRecords.length === 0) {
    note =
      "Nearby places came from OpenStreetMap. The Zomato dataset could not be loaded, so its ratings and prices were not added.";
  } else if ((input.diet || []).length > 0) {
    note =
      "Zomato ratings and prices are available only for matched places. Dietary tags may be incomplete; confirm ingredients and food preparation directly.";
  } else {
    note =
      "Nearby places come from OpenStreetMap. Zomato details are added only when a restaurant name, city, and available coordinates match. Dataset ratings and prices may be outdated.";
  }

  return json(200, {
    restaurants: selected,
    note,
    sources: {
      nearbyPlaces: "OpenStreetMap",
      enrichment: "Zomato dataset",
      zomatoRecordsLoaded: zomatoRecords.length
    }
  });
};
