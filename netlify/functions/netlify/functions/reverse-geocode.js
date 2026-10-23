
const INDIA_BOUNDS = {
  minLat: 6.0,
  maxLat: 37.5,
  minLon: 68.0,
  maxLon: 98.0
};

function send(statusCode, data) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(data)
  };
}

function isInsideIndiaBounds(lat, lon) {
  return (
    lat >= INDIA_BOUNDS.minLat &&
    lat <= INDIA_BOUNDS.maxLat &&
    lon >= INDIA_BOUNDS.minLon &&
    lon <= INDIA_BOUNDS.maxLon
  );
}

function getCity(address) {
  return (
    address.city ||
    address.town ||
    address.village ||
    address.municipality ||
    address.city_district ||
    address.county ||
    ""
  );
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      },
      body: ""
    };
  }

  if (event.httpMethod !== "POST") {
    return send(405, {
      error: "Method not allowed. Please use POST."
    });
  }

  let body;

  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return send(400, {
      error: "Invalid request data."
    });
  }

  const lat = Number(body.lat);
  const lon = Number(body.lon);

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    return send(400, {
      error: "Please provide valid latitude and longitude."
    });
  }

  if (!isInsideIndiaBounds(lat, lon)) {
    return send(400, {
      error: "NearBites India currently supports locations in India only."
    });
  }

  try {
    const params = new URLSearchParams({
      lat: String(lat),
      lon: String(lon),
      format: "jsonv2",
      addressdetails: "1",
      zoom: "10"
    });

    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?${params}`,
      {
        headers: {
          "Accept": "application/json",
          "User-Agent": "NearBitesIndia/1.0 (restaurant discovery website)"
        }
      }
    );

    if (!response.ok) {
      return send(502, {
        error: "The map service is temporarily unavailable. Please enter your city and state manually."
      });
    }

    const result = await response.json();
    const address = result.address || {};

    if (
      !result.address ||
      String(address.country_code || "").toLowerCase() !== "in"
    ) {
      return send(400, {
        error: "We could not verify this as a location in India. Please enter your city and state manually."
      });
    }

    const city = getCity(address);
    const state = address.state || "";

    if (!city || !state) {
      return send(200, {
        city,
        state,
        country: "India",
        message: "Location found, but some address details may be missing."
      });
    }

    return send(200, {
      city,
      state,
      country: "India"
    });
  } catch (error) {
    console.error("Reverse geocoding failed:", error.message);

    return send(502, {
      error: "Could not determine your location right now. Please enter your city and state manually."
    });
  }
};
