/**
 * @author qiao / https://github.com/qiao
 * @author mrdoob / http://mrdoob.com
 * @author alteredq / http://alteredqualia.com/
 * @author WestLangley / http://github.com/WestLangley
 */

import * as THREE from '../../build/three.module.js';
import { OrbitControls } from '../../examples/jsm/controls/OrbitControls.js';

var _box = new THREE.Box3();
var _sphere = new THREE.Sphere();
var _delta = new THREE.Vector3();

function EditorControls( object, domElement ) {

	OrbitControls.call( this, object, domElement );

}

EditorControls.prototype = Object.assign( Object.create( OrbitControls.prototype ), {

	constructor: EditorControls,

	focus: function ( target ) {

		var distance;

		_box.setFromObject( target );

		if ( _box.isEmpty() === false ) {

			_box.getCenter( this.target );
			distance = _box.getBoundingSphere( _sphere ).radius;

		} else {

			// Focusing on an Group, AmbientLight, etc

			this.target.setFromMatrixPosition( target.matrixWorld );
			distance = 0.1;

		}

		_delta.set( 0, 0, 1 );
		_delta.applyQuaternion( this.object.quaternion );
		_delta.multiplyScalar( distance * 4 );

		this.object.position.copy( this.target ).add( _delta );

		this.dispatchEvent( { type: 'change' } );

	}

} );

export { EditorControls };
