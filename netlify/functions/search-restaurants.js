
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

function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = n => n * Math.PI / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) *
    Math.cos(rad(lat2)) *
    Math.sin(dLon / 2) ** 2;

  return 6371 * 2 *
    Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tagText(tags) {
  return [
    tags.cuisine,
    tags.name,
    tags.amenity,
    tags.shop,
    tags.brand,
    tags.description,
    tags["diet:vegetarian"] === "yes" ? "vegetarian" : "",
    tags["diet:vegan"] === "yes" ? "vegan" : ""
  ].filter(Boolean).join(" ").toLowerCase();
}

function kindOf(tags) {
  if (tags.amenity === "cafe") return "Café";
  if (tags.amenity === "restaurant") return "Restaurant";
  if (tags.amenity === "fast_food") return "Fast food";
  if (tags.amenity === "food_court") return "Food court";
  if (tags.amenity === "ice_cream" || tags.shop === "ice_cream") {
    return "Ice cream";
  }
  if (tags.shop === "bakery") return "Bakery";
  if (tags.shop === "pastry") return "Bakery";
  if (tags.shop === "confectionery") return "Dessert shop";
  return "Food place";
}

function scorePlace(tags, prefs, distance) {
  let score = 0;
  const reasons = [];
  const searchable = normalize(tagText(tags));
  const kind = kindOf(tags);

  // Cafés receive a modest preference because NearBites focuses on them.
  if (tags.amenity === "cafe") {
    score += 3;
    reasons.push("Café");
  }

  // Match selected cuisines against the mapped cuisine and place tags.
  const cuisines = (prefs.cuisine || [])
    .filter(item => item !== "Any cuisine");

  const cuisineMatches = cuisines.filter(item => {
    const wanted = normalize(item);
    return wanted && searchable.includes(wanted);
  });

  if (cuisineMatches.length) {
    score += cuisineMatches.length * 6;
    reasons.push("Cuisine: " + cuisineMatches.join(", "));
  }

  // Match the selected type of place.
  const selectedPlaces = prefs.places || [];
  const placeMatches = selectedPlaces.filter(item => {
    if (item === "Vegetarian place") {
      return tags["diet:vegetarian"] === "yes";
    }

    if (item === "Dessert shop") {
      return (
        kind === "Dessert shop" ||
        kind === "Ice cream" ||
        /dessert|cake|sweet|ice cream|confectionery/.test(searchable)
      );
    }

    if (item === "Café") return tags.amenity === "cafe";
    if (item === "Restaurant") return tags.amenity === "restaurant";
    if (item === "Fast food") return tags.amenity === "fast_food";
    if (item === "Food court") return tags.amenity === "food_court";
    if (item === "Bakery") {
      return ["Bakery", "Dessert shop"].includes(kind);
    }

    return normalize(kind).includes(normalize(item));
  });

  if (placeMatches.length) {
    score += placeMatches.length * 5;
    reasons.push("Place type match");
  }

  // Only use explicit dietary tags as evidence.
  // Missing tags do not prove that a place is suitable or unsuitable.
  const dietTagMap = {
    "Vegetarian": tags["diet:vegetarian"],
    "Vegan": tags["diet:vegan"],
    "Jain": tags["diet:jain"],
    "Halal": tags["diet:halal"],
    "Gluten-free": tags["diet:gluten_free"],
    "Dairy-free": tags["diet:dairy_free"]
  };

  const diets = prefs.diet || [];
  const knownSuitable = diets.filter(item => dietTagMap[item] === "yes");

  if (knownSuitable.length) {
    score += knownSuitable.length * 4;
    reasons.push("Diet tags: " + knownSuitable.join(", "));
  }

  const knownUnsuitable = diets.filter(
    item => dietTagMap[item] === "no"
  );

  if (knownUnsuitable.length) {
    score -= knownUnsuitable.length * 10;
  }

  // Nearby places receive a small bonus.
  const radiusKm = Math.max(
    1,
    Math.min(20, Number(prefs.radius || 5000) / 1000)
  );

  score += Math.max(0, 4 - (distance / radiusKm) * 4);

  if (prefs.priority === "distance") {
    score += Math.max(0, 8 - distance);
  }

  if (prefs.priority === "rating") {
    const rating = Number(tags.stars);
    if (Number.isFinite(rating) && rating > 0) {
      score += Math.min(5, rating);
    }
  }

  if (prefs.priority === "value") {
    const price = normalize(tags.price || "");
    if (/budget|cheap|inexpensive|low/.test(price)) {
      score += 3;
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
    return {
      statusCode: 204,
      headers,
      body: ""
    };
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

  // Search only around coordinates supplied by location verification.
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < 6 ||
    lat > 37.5 ||
    lon < 68 ||
    lon > 98.5
  ) {
    return json(400, {
      error: "Your saved location is invalid. Verify and save it again."
    });
  }

  const radius = Math.max(
    1000,
    Math.min(20000, Number(input.radius) || 5000)
  );

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

  // Try the backup OpenStreetMap query server if necessary.
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded;charset=UTF-8",
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

    const result = scorePlace(tags, input, distance);

    const address = [
      tags["addr:housenumber"],
      tags["addr:street"],
      tags["addr:suburb"] ||
        tags["addr:neighbourhood"] ||
        tags["addr:city"]
    ].filter(Boolean).join(" ");

    places.push({
      name,
      distanceKm: Math.round(distance * 100) / 100,
      distanceLabel: distance < 1
        ? `${Math.round(distance * 1000)} m`
        : `${distance.toFixed(1)} km`,
      address,
      cuisine: String(tags.cuisine || "")
        .split(";")
        .map(item => item.trim())
        .filter(Boolean)
        .map(item =>
          item.replace(/\b\w/g, char => char.toUpperCase())
        )
        .join(", "),
      kind: kindOf(tags),
      diet: tags["diet:vegetarian"] === "yes"
        ? "Vegetarian options tagged"
        : "",
      rating: tags.stars || null,
      price: tags.price || null,
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
  } else if ((input.diet || []).length > 0) {
    note =
      "Dietary tags and restaurant details may be incomplete. Contact a place directly to confirm ingredients and food preparation.";
  } else {
    note =
      "Results depend on OpenStreetMap coverage. Ratings, prices, and other details may be missing or unverified.";
  }

  return json(200, {
    restaurants: selected,
    note
  });
};
