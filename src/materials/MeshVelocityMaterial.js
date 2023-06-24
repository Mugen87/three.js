import { Material } from './Material.js';

class MeshVelocityMaterial extends Material {

	constructor( parameters ) {

		super();

		this.type = 'MeshVelocityMaterial';

		this.displacementMap = null;
		this.displacementScale = 1;
		this.displacementBias = 0;

		this.alphaMap = null;

		this.skinning = false;
		this.morphTargets = false;

		this.fog = false;
		this.lights = false;

		this.flatShading = false;

		this.setValues( parameters );

	}

	copy( source ) {

		super.copy( source );

		this.displacementMap.copy( source.displacementMap );
		this.displacementScale = source.displacementScale;
		this.displacementBias = source.displacementBias;

		this.alphaMap.copy( source.alphaMap );

		this.skinning = source.skinning;
		this.morphTargets = source.morphTargets;

		this.flatShading = source.flatShading;

		return this;

	}

}

MeshVelocityMaterial.prototype.isMeshVelocityMaterial = true;

export { MeshVelocityMaterial };
