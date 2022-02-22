import { Light } from './Light.js';
import { DirectionalLightShadow } from './DirectionalLightShadow.js';

class DirectionalLight extends Light {

	constructor( color, intensity ) {

		super( color, intensity );

		this.type = 'DirectionalLight';

		this.shadow = new DirectionalLightShadow();

	}

	dispose() {

		this.shadow.dispose();

	}

	copy( source ) {

		super.copy( source );

		this.shadow = source.shadow.clone();

		return this;

	}

}

DirectionalLight.prototype.isDirectionalLight = true;

export { DirectionalLight };
