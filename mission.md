# Role & Goal
You are an expert game developer specializing in 2D minimalist arcade physics. Your task is to build a fully functional, highly polished clone of the game "Don't Touch The Spikes" using HTML5, Canvas, and vanilla JavaScript (ES6+). The entire game must be contained within a single self-contained HTML file.

## Technical Specifications

### 1. Canvas Layout & Screen Management
- Aspect Ratio: Fixed vertical 9:16 layout with an internal native resolution of 540x960 pixels.
- Responsiveness: Scale the canvas element automatically using CSS (`max-width: 100%; max-height: 100vh; object-fit: contain;`) to fit the user's viewport perfectly while preserving the 540x960 internal coordinate system.
- Background & Typography: Use a modern minimalist pastel theme (e.g., light gray background `#ecef1`). Display a large, centered, faint gray font (e.g., 180px bold Arial) behind the game elements to track the current round score dynamically.

### 2. Bird Physics & Input Mechanics
- Dimensions & Rendering: Model the bird as a circle (radius = 16px). Programmatically draw it with an eye and a distinct small triangle beak that points in the current direction of travel.
- Input System: Bind both the `Spacebar` and a global canvas click/touch event.
- Exact Physics Constants (60 FPS baseline):
  * Gravity: Constant downward acceleration of `0.45 px/frame²`.
  * Flap Force: Pressing input instantly resets the vertical velocity to a fixed upward value: `v_y = -8.5 px/frame`. It must completely overwrite previous vertical momentum rather than accumulating.
  * Horizontal Speed: Constant speed of `|v_x| = 4.5 px/frame`.
- Directional Behavior: The bird only switches its horizontal direction (`v_x = -v_x`) upon a valid collision matrix match with the left or right wall boundaries. Flip the beak and eye rendering to match the flight direction.

### 3. Obstacle Logic (Spikes)
- Visual Style: Draw all spikes as sharp triangles with a base width of 30px and a height of 24px using `ctx.lineTo()`.
- Static Danger Zones: Continuous, uniform rows of static spikes completely lining the absolute top (ceiling) and absolute bottom (floor) coordinates.
- Dynamic Wall Spikes: Divide both the left and right vertical walls into exactly 11 equal vertical grid slots (~70px height per slot).
  * Safety Padding: The absolute top-most slot (Slot 0) and bottom-most slot (Slot 10) must ALWAYS remain clear of spikes to prevent impossible corner traps.
- Spike Regeneration Loop: 
  * At game launch, Wall A is safe; Wall B spawns a baseline set of random spikes.
  * The exact millisecond the bird hits Wall B, all spikes on Wall B vanish. Wall A immediately rolls a random uniform selection to spawn a new set of spikes.
- Game Difficulty Scaling:
  * Score 0 to 5: Spawn 2 to 3 random spikes on the opposite wall.
  * Score 6 to 15: Spawn 3 to 4 random spikes.
  * Score 16+: Spawn 4 to 5 random spikes. Maximum cap is 5 spikes to preserve mathematical fairness.

### 4. Currency System (Candy)
- Spawning Metrics: Every single time a wall regenerates its spike layout, run a flat 50% probability roll. If successful, spawn one candy near that active, opposite wall.
- Placement & Rendering: Draw the candy programmatically as a rotating diamond or small candy icon. It must choose its vertical position randomly from one of the designated "safe slots" (empty slots without a spike) on that active wall, offset 40px inward from the wall border.
- Collection: Implement a simple circle-to-circle or bounding box intersection check between the bird and candy. On overlap, increment a persistent `localStorage` lifetime candy counter, spawn a tiny burst particle effect, and delete the candy instance from the screen.

### 5. Game Juiciness & Polish (Crucial)
- Screenshake: Implement a brief canvas transformation offset (e.g., random x/y offset between -5px and 5px lasting for 8 frames) whenever the player scores or takes damage.
- Particle Systems: 
  * Wall Bounce: Spawn 5-7 tiny square debris particles matching the wall color that burst outwards when the bird bounces.
  * Candy Capture: Spawn a burst of 10 golden sparkly particles that drift downward and fade out using alpha values.
- Game Over Sequence: Upon spike impact, freeze horizontal motion instantly. Apply a brief screen white-flash effect. Make the bird spin upside down and plunge rapidly off the bottom screen boundary before showing the final scoreboard card.

### 6. State Machine Architecture
Implement a strict, clean architecture separating logic updates from drawing routines across 3 explicit states:
1. START_MENU: Displays the title logo, local high score, and a pulsing "Tap to Jump" text overlay. The bird ignores gravity, moving softly up and down via a mathematical sine-wave loop (`Math.sin(time) * 15px`).
2. GAMEPLAY: Activates on first player input. Tracks current round score. Validates all collision matrices (Spikes = Instant Death, Candy = Collection, Walls = Turnaround & +1 Point).
3. GAME_OVER: Displays a sleek modal card showing Final Score, Best Personal Score, Total Lifetime Candies, and a large, easily clickable "Play Again" button that resets all temporary gameplay vectors cleanly.
