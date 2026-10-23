
function send(statusCode, data) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(data)
  };
}

function clean(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.,'’\-_/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matches(input, actual) {
  const a = clean(input);
  const b = clean(actual);
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return send(405, { error: "Use POST to verify a location." });
  }

  let body;

  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return send(400, { error: "Invalid request data." });
  }

  const city = String(body.city || "").trim();
  const state = String(body.state || "").trim();
  const road = String(body.road || "").trim();

  if (!city || !state || !road) {
    return send(400, {
      error: "Enter your city, state, and road or locality."
    });
  }

  if (city.length > 80 || state.length > 80 || road.length > 120) {
    return send(400, { error: "One of the location fields is too long." });
  }

  try {
    const query = new URLSearchParams({
      q: `${road}, ${city}, ${state}, India`,
      format: "jsonv2",
      addressdetails: "1",
      countrycodes: "in",
      limit: "5"
    });

    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?${query}`,
      {
        headers: {
          "Accept": "application/json",
          "User-Agent": "NearBitesIndia/1.0 (location verification)"
        }
      }
    );

    if (!response.ok) {
      return send(502, {
        error: "The map service is unavailable. Please try again later."
      });
    }

    const results = await response.json();

    if (!Array.isArray(results) || results.length === 0) {
      return send(422, {
        error: "We couldn't verify this road or locality in India. Check the spelling or try a nearby named locality."
      });
    }

    const match = results.find(result => {
      const address = result.address || {};

      const resultCity =
        address.city ||
        address.town ||
        address.village ||
        address.municipality ||
        address.city_district ||
        "";

      const resultState = address.state || "";

      const resultRoad =
        address.road ||
        address.pedestrian ||
        address.footway ||
        address.residential ||
        address.neighbourhood ||
        address.suburb ||
        "";

      return (
        String(address.country_code || "").toLowerCase() === "in" &&
        matches(city, resultCity) &&
        matches(state, resultState) &&
        matches(road, resultRoad)
      );
    });

    if (!match) {
      return send(422, {
        error: "We couldn't confirm that this road belongs to the city and state entered. Check the details or try a nearby mapped locality."
      });
    }

    return send(200, {
      city,
      state,
      road,
      country: "India",
      lat: Number(match.lat),
      lon: Number(match.lon),
      displayName: match.display_name
    });
  } catch (error) {
    console.error("Location verification failed:", error.message);

    return send(502, {
      error: "We couldn't verify this location right now. Please try again later."
    });
  }
};
