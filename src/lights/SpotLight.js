import { Light } from './Light.js';
import { SpotLightShadow } from './SpotLightShadow.js';

class SpotLight extends Light {

	constructor( color, intensity, distance = 0, angle = Math.PI / 3, penumbra = 0, decay = 1 ) {

		super( color, intensity );

		this.type = 'SpotLight';

		this.distance = distance;
		this.angle = angle;
		this.penumbra = penumbra;
		this.decay = decay; // for physically correct lights, should be 2.

		this.shadow = new SpotLightShadow();

	}

	get power() {

		// compute the light's luminous power (in lumens) from its intensity (in candela)
		// by convention for a spotlight, luminous power (lm) = π * luminous intensity (cd)
		return this.intensity * Math.PI;

	}

	set power( power ) {

		// set the light's intensity (in candela) from the desired luminous power (in lumens)
		this.intensity = power / Math.PI;

	}

	dispose() {

		this.shadow.dispose();

	}

	copy( source ) {

		super.copy( source );

		this.distance = source.distance;
		this.angle = source.angle;
		this.penumbra = source.penumbra;
		this.decay = source.decay;

		this.shadow = source.shadow.clone();

		return this;

	}

}

SpotLight.prototype.isSpotLight = true;

export { SpotLight };
