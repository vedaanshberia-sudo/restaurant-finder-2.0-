
const headers = {
  "Content-Type": "application/json",
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
    Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function kindOf(tags) {
  if (tags.amenity === "cafe") return "Café";
  if (tags.amenity === "fast_food") return "Fast food";
  if (tags.amenity === "food_court") return "Food court";
  if (tags.shop === "bakery") return "Bakery";
  if (tags.amenity === "restaurant") return "Restaurant";
  if (tags.amenity === "ice_cream") return "Ice cream";
  return "Food place";
}

function scorePlace(tags, prefs, distance) {
  let score = 0;
  const reasons = [];

  const searchable = [
    tags.cuisine,
    tags.name,
    tags.amenity,
    tags.shop,
    tags["diet:vegetarian"] === "yes" ? "vegetarian" : "",
    tags["diet:vegan"] === "yes" ? "vegan" : ""
  ].filter(Boolean).join(" ").toLowerCase();

  const foodMatches = (prefs.food || []).filter(item =>
    searchable.includes(item.toLowerCase())
  );

  if (foodMatches.length) {
    score += foodMatches.length * 5;
    reasons.push("Food: " + foodMatches.join(", "));
  }

  const cuisineMatches = (prefs.cuisine || []).filter(item =>
    searchable.includes(item.toLowerCase())
  );

  if (cuisineMatches.length) {
    score += cuisineMatches.length * 6;
    reasons.push("Cuisine: " + cuisineMatches.join(", "));
  }

  const kind = kindOf(tags).toLowerCase();

  const placeMatches = (prefs.places || []).filter(item => {
    if (item === "Vegetarian place") {
      return tags["diet:vegetarian"] === "yes";
    }
    if (item === "Dessert shop") {
      return /dessert|ice_cream|cake|sweet/i.test(searchable);
    }
    return kind.includes(item.toLowerCase());
  });

  if (placeMatches.length) {
    score += placeMatches.length * 4;
    reasons.push("Place type match");
  }

  const dietMap = {
    "Vegetarian": tags["diet:vegetarian"] === "yes",
    "Vegan": tags["diet:vegan"] === "yes",
    "Jain": tags["diet:jain"] === "yes",
    "Halal": tags["diet:halal"] === "yes",
    "Gluten-free": tags["diet:gluten_free"] === "yes",
    "Dairy-free": tags["diet:dairy_free"] === "yes"
  };

  const dietMatches = (prefs.diet || []).filter(item =>
    dietMap[item] === true
  );

  if (dietMatches.length) {
    score += dietMatches.length * 5;
    reasons.push("Diet tags: " + dietMatches.join(", "));
  }

  const vibeTags = [
    tags.ambience,
    tags.outdoor_seating === "yes" ? "outdoor seating" : "",
    tags.quiet
  ].filter(Boolean).join(" ").toLowerCase();

  const vibeMatches = (prefs.vibes || []).filter(item =>
    vibeTags.includes(item.toLowerCase())
  );

  score += vibeMatches.length * 2;

  // Nearby places receive a modest bonus.
  const radiusKm = Math.max(1, Number(prefs.radius || 5000) / 1000);
  score += Math.max(0, 4 - distance / radiusKm * 4);

  if (prefs.priority === "distance") {
    score += Math.max(0, 8 - distance);
  }

  if (prefs.priority === "rating" && tags.stars) {
    score += Math.min(5, Number(tags.stars) || 0);
  }

  if (prefs.priority === "value" &&
      /budget|cheap|inexpensive/i.test(searchable)) {
    score += 3;
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
    return json(405, { error: "Use POST for restaurant searches." });
  }

  try {
    const input = JSON.parse(event.body || "{}");
    const location = input.location || {};

    const city = String(location.city || "").trim();
    const state = String(location.state || "").trim();

    if (!city || !state) {
      return json(400, {
        error: "Enter your Indian city and state first."
      });
    }

    const radius = Math.max(
      1000,
      Math.min(20000, Number(input.radius) || 5000)
    );

    let lat = Number(location.lat);
    let lon = Number(location.lon);

    // If the user typed a city, find its coordinates.
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      const params = new URLSearchParams({
        city,
        state,
        country: "India",
        countrycodes: "in",
        format: "jsonv2",
        addressdetails: "1",
        limit: "5"
      });

      const response = await fetch(
        "https://nominatim.openstreetmap.org/search?" + params,
        {
          headers: {
            "User-Agent": "NearBitesIndia/1.0",
            "Accept-Language": "en"
          }
        }
      );

      if (!response.ok) {
        return json(502, {
          error: "Location lookup is temporarily unavailable. Try again."
        });
      }

      const matches = await response.json();
      const found = matches.find(
        item => item.address?.country_code === "in"
      );

      if (!found) {
        return json(400, {
          error: "We couldn't verify this Indian city and state. Check your spelling."
        });
      }

      lat = Number(found.lat);
      lon = Number(found.lon);
    }

    // Broad geographic guard for India.
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < 6 || lat > 37.5 ||
      lon < 68 || lon > 98.5
    ) {
      return json(400, {
        error: "NearBites only supports locations in India."
      });
    }

    // Find restaurants, cafes, fast food, bakeries and food courts.
    const query = `
      [out:json][timeout:25];
      (
        nwr(around:${radius},${lat},${lon})
          ["amenity"~"^(restaurant|cafe|fast_food|food_court|ice_cream)$"];
        nwr(around:${radius},${lat},${lon})
          ["shop"~"^(bakery|pastry|confectionery)$"];
      );
      out center tags;
    `;

    const endpoints = [
      "https://overpass-api.de/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter"
    ];

    let elements = null;

    // Try a backup public map server if the first is unavailable.
    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type":
              "application/x-www-form-urlencoded;charset=UTF-8",
            "User-Agent": "NearBitesIndia/1.0"
          },
          body: "data=" + encodeURIComponent(query)
        });

        if (response.ok) {
          const result = await response.json();
          elements = result.elements || [];
          break;
        }
      } catch (error) {
        // Try the next endpoint.
      }
    }

    if (elements === null) {
      return json(503, {
        error: "The free map service is busy. Please try again shortly."
      });
    }

    const seen = new Set();
    const places = [];

    for (const element of elements) {
      const tags = element.tags || {};

      const placeLat = Number(element.lat ?? element.center?.lat);
      const placeLon = Number(element.lon ?? element.center?.lon);

      // Skip unnamed places and invalid coordinates.
      if (
        !tags.name ||
        !Number.isFinite(placeLat) ||
        !Number.isFinite(placeLon)
      ) continue;

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
        name: tags.name,
        distanceKm: Math.round(distance * 100) / 100,
        distanceLabel: distance < 1
          ? `${Math.round(distance * 1000)} m`
          : `${distance.toFixed(1)} km`,
        address,
        cuisine: String(tags.cuisine || "")
          .split(";")
          .map(x => x.trim())
          .filter(Boolean)
          .map(x => x.replace(/\b\w/g, c => c.toUpperCase()))
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

    return json(200, {
      restaurants: places.slice(0, 12),
      note: places.length === 0
        ? "No named places were found. Try a larger search radius."
        : ""
    });

  } catch (error) {
    return json(500, {
      error: "Something went wrong during the search. Please try again."
    });
  }
};
