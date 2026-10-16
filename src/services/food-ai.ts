import { claudeProxyPost } from '@/services/claude-proxy';

export type FoodItem = { name: string; quantity: string };

export type DetectedMeal = {
  items: FoodItem[];
  macros: { calories: number; protein: number; carbs: number; fat: number };
};

// Thin wrapper that applies the default model/token settings for food analysis.
async function claudePost(body: object): Promise<string> {
  return claudeProxyPost({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    ...body,
  });
}

function parseJSON<T>(text: string): T {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Could not parse response from Claude');
  return JSON.parse(match[0]) as T;
}

/**
 * Send a base64 meal photo to Claude and get back detected foods + macro estimate.
 */
export async function analyzeMealPhoto(
  base64: string,
  _mimeType: string = 'image/jpeg',  // always send as jpeg — picker converts but may label as heic
): Promise<DetectedMeal> {
  const text = await claudePost({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: base64 },
          },
          {
            type: 'text',
            text: `You are a registered dietitian with expert knowledge of USDA FoodData Central values. Analyze this meal photo as accurately as possible.

Guidelines:
- Use any visible plates, utensils, hands, or containers to estimate portion sizes
- List EVERY food item including condiments, dressings, oils, butter, sauces, and toppings — these are commonly missed and significantly affect calories
- Use standard USDA/nutrition database values for each item
- For restaurant-style dishes, account for typical added fats in preparation
- Be specific about cooking method when it affects macros (e.g. "pan-fried" vs "grilled")

Reply ONLY with valid JSON — no markdown fences, no explanation:
{
  "items": [
    {"name": "grilled salmon fillet", "quantity": "5 oz"},
    {"name": "steamed broccoli", "quantity": "1 cup"},
    {"name": "brown rice, cooked", "quantity": "3/4 cup"},
    {"name": "olive oil (cooking)", "quantity": "1 tsp"}
  ],
  "macros": {"calories": 610, "protein": 46, "carbs": 52, "fat": 18}
}`,
          },
        ],
      },
    ],
  });

  return parseJSON<DetectedMeal>(text);
}

/**
 * Re-estimate macros from a plain-text food description (used when user edits the detected foods).
 */
export async function estimateMacrosFromText(
  description: string,
): Promise<DetectedMeal['macros']> {
  const text = await claudePost({
    messages: [
      {
        role: 'user',
        content: `You are a registered dietitian. Estimate the total nutritional content for this meal using USDA FoodData Central values.

Meal: ${description}

Rules:
- If a quantity is not specified, assume a typical single adult serving
- Account for any oils, butter, or sauces typical for this type of dish
- Sum all items for the total

Reply ONLY with valid JSON — no explanation, no markdown:
{"calories": 0, "protein": 0, "carbs": 0, "fat": 0}`,
      },
    ],
  });

  return parseJSON<DetectedMeal['macros']>(text);
}
