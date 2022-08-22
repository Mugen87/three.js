import {
	BufferGeometry,
	CompressedTexture,
	DoubleSide,
	FileLoader,
	Float32BufferAttribute,
	FrontSide,
	Group,
	Loader,
	LoaderUtils,
	Mesh,
	MeshBasicMaterial,
	MeshLambertMaterial,
	RepeatWrapping,
	RGBA_S3TC_DXT1_Format,
	RGBA_S3TC_DXT3_Format,
	RGBA_S3TC_DXT5_Format,
	RGBA_BPTC_Format,
	Vector2,
	Vector3
} from 'three';

// The loader in its current state is just a foundation for a more advanced M2 loader. Right now, the class only implements
// a small portion of what is defined at https://wowdev.wiki/M2.

class M2Loader extends Loader {

	constructor( manager ) {

		super( manager );

	}

	load( url, onLoad, onProgress, onError ) {

		const loader = new FileLoader( this.manager );
		loader.setPath( this.path );
		loader.setResponseType( 'arraybuffer' );
		loader.setRequestHeader( this.requestHeader );
		loader.setWithCredentials( this.withCredentials );
		loader.load( url, ( buffer ) => {

			try {

				this.parse( buffer, url, function ( object ) {

					onLoad( object );

				} );

			} catch ( e ) {

				if ( onError ) {

					onError( e );

				} else {

					console.error( e );

				}

				this.manager.itemError( url );

			}

		}, onProgress, onError );

	}

	parse( buffer, path, onLoad, onError ) {

		const parser = new BinaryParser( buffer );

		const promises = [];

		// magic

		let magic = parser.readString( 4 );

		if ( magic === 'MD21' ) {

			const md21ChunkSize = parser.readUInt32(); // eslint-disable-line no-unused-vars

			parser.chunkOffset = parser.offset; // offsets inside MD21 are relative to the chunk, not the file

			magic = parser.readString( 4 );

		}

		if ( magic !== 'MD20' ) {

			throw new Error( 'THREE.M2Loader: Invalid magic data' );

		}

		// headers

		const header = this._readHeader( parser );

		if ( header.version >= M2_VERSION_LEGION ) {

			throw new Error( 'THREE.M2Loader: M2 asset from Legion or higher are not supported yet.' );

		}

		// data

		const name = this._readName( parser, header );
		const vertices = this._readVertices( parser, header );
		const textureDefinitions = this._readTextureDefinitions( parser, header );
		const textureLookupTable = this._readTextureLookupTable( parser, header );
		const materials = this._readMaterials( parser, header );

		// textures

		const resourcePath = LoaderUtils.extractUrlBase( path );

		const textureLoader = new BLPLoader( this.manager );
		textureLoader.setPath( resourcePath );

		for ( let i = 0; i < textureDefinitions.length; i ++ ) {

			const textureDefinition = textureDefinitions[ i ];
			let filename = textureDefinition.filename;

			if ( i === 0 && filename === '' ) filename = name + '.blp'; // if the first texture has an empty name, fallback on the .m2 name

			const promise = new Promise( ( resolve, reject ) => {

				const config = {
					url: filename,
					flags: textureDefinition.flags
				};

				textureLoader.load( config, resolve, undefined, () => {

					reject( new Error( 'THREE.M2Loader: Failed to load texture: ' + filename ) );

				} );

			} );

			promises.push( promise );

		}

		// skins

		Promise.all( promises ).then( ( textures ) => {

			// skins

			if ( header.version <= M2_VERSION_THE_BURNING_CRUSADE ) {

				// TODO: read embedded skin data

			} else {

				// TODO ignore header.numSkinProfiles for now and just load the default skin

				const url = ( name + '00.skin' ).toLowerCase();
				const skinLoader = new M2SkinLoader( this.manager );
				skinLoader.setPath( resourcePath );
				skinLoader.setHeader( header );

				const promise = new Promise( ( resolve, reject ) => {

					skinLoader.load( url, resolve, undefined, () => {

						reject( new Error( 'THREE.M2Loader: Failed to load skin file: ' + url ) );

					} );

				} );

				// build

				promise.then( skinData => {

					const group = this._build( name, vertices, materials, skinData, textures, textureLookupTable );
					onLoad( group );

				} ).catch( onError );

			}

		} ).catch( onError );

	}

	_build( name, vertices, materials, skinData, textures, textureLookupTable ) {

		const group = new Group();

		// geometry

		const localVertexList = skinData.localVertexList;
		const indices = skinData.indices;
		const submeshes = skinData.submeshes;
		const batches = skinData.batches;

		// buffer attributes

		const position = [];
		const normal = [];
		const uv = [];

		for ( let i = 0; i < localVertexList.length; i ++ ) {

			const vertexIndex = localVertexList[ i ];
			const vertex = vertices[ vertexIndex ];

			// TODO: Implement up-axis conversion (z-up to y-up), figure out if WoW is left- or right-handed

			position.push( vertex.pos.x, vertex.pos.y, vertex.pos.z );
			normal.push( vertex.normal.x, vertex.normal.y, vertex.normal.z );
			uv.push( vertex.texCoords[ 0 ].x, vertex.texCoords[ 0 ].y );

		}

		const positionAttribute = new Float32BufferAttribute( position, 3 );
		const normalAttribute = new Float32BufferAttribute( normal, 3 );
		const uvAttribute = new Float32BufferAttribute( uv, 2 );

		// geometries

		const geometries = [];

		for ( let i = 0; i < submeshes.length; i ++ ) {

			const submesh = submeshes[ i ];

			const index = indices.slice( submesh.indexStart, submesh.indexStart + submesh.indexCount );

			const geometry = new BufferGeometry();
			geometry.setAttribute( 'position', positionAttribute );
			geometry.setAttribute( 'normal', normalAttribute );
			geometry.setAttribute( 'uv', uvAttribute );
			geometry.setIndex( index );

			geometries.push( geometry );

		}

		// meshes

		for ( let i = 0; i < batches.length; i ++ ) {

			const batch = batches[ i ];

			const materialDefinition = materials[ batch.materialIndex ];
			const materialFlags = materialDefinition.flags;
			const blendingMode = materialDefinition.blendingMode;

			// TODO Honor remaining material flags and blending modes

			const material = ( materialFlags & M2_MATERIAL_UNLIT ) ? new MeshBasicMaterial() : new MeshLambertMaterial();

			material.fog = ( materialFlags & M2_MATERIAL_UNFOGGED ) ? false : true;
			material.side = ( materialFlags & M2_MATERIAL_TWO_SIDED ) ? DoubleSide : FrontSide;
			material.depthTest = ( materialFlags & M2_MATERIAL_DEPTH_TEST ) ? false : true;
			material.depthWrite = ( materialFlags & M2_MATERIAL_DEPTH_WRITE ) ? false : true;

			switch ( blendingMode ) {

				case M2_BLEND_OPAQUE:
					material.alphaTest = 0;
					material.transparent = false;
					break;

				case M2_BLEND_ALPHA_KEY:
					material.alphaTest = 0.5;
					material.transparent = false;
					break;

				case M2_BLEND_ALPHA:
					material.alphaTest = 0;
					material.transparent = true;
					break;

				default:
					console.warn( 'THREE.M2Loader: Unsupported blending mode.' );
					break;

			}

			const textureIndex = textureLookupTable[ batch.textureComboIndex ];
			material.map = textures[ textureIndex ];

			// mesh

			const geometry = geometries[ batch.skinSectionIndex ];

			const mesh = new Mesh( geometry, material );
			group.add( mesh );

		}

		group.name = name;

		return group;

	}

	_readHeader( parser ) {

		const header = {};

		header.version = parser.readUInt32();
		header.nameLength = parser.readUInt32();
		header.nameOffset = parser.readUInt32();
		header.globalFlags = parser.readUInt32();
		header.globalLoopsLength = parser.readUInt32();
		header.globalLoopsOffset = parser.readUInt32();
		header.sequencesLength = parser.readUInt32();
		header.sequencesOffset = parser.readUInt32();
		header.sequenceIdxHashByIdLength = parser.readUInt32();
		header.sequenceIdxHashByOffset = parser.readUInt32();

		if ( header.version <= M2_VERSION_THE_BURNING_CRUSADE ) {

			header.playableAnimationLookupLength = parser.readUInt32();
			header.playableAnimationLookupOffset = parser.readUInt32();

		}

		header.bonesLength = parser.readUInt32();
		header.bonesOffset = parser.readUInt32();
		header.boneIndicesByIdLength = parser.readUInt32();
		header.boneIndicesByIdOffset = parser.readUInt32();
		header.verticesLength = parser.readUInt32();
		header.verticesOffset = parser.readUInt32();

		if ( header.version <= M2_VERSION_THE_BURNING_CRUSADE ) {

			header.skinProfilesLength = parser.readUInt32();
			header.skinProfilesOffset = parser.readUInt32();

		} else {

			header.numSkinProfiles = parser.readUInt32();

		}

		header.colorsLength = parser.readUInt32();
		header.colorsOffset = parser.readUInt32();
		header.texturesLength = parser.readUInt32();
		header.texturesOffset = parser.readUInt32();
		header.textureWeightsLength = parser.readUInt32();
		header.textureWeightsOffset = parser.readUInt32();

		if ( header.version <= M2_VERSION_THE_BURNING_CRUSADE ) {

			header.textureFlipbooksLength = parser.readUInt32();
			header.textureFlipbooksOffset = parser.readUInt32();

		}

		header.textureTransformsLength = parser.readUInt32();
		header.textureTransformsOffset = parser.readUInt32();
		header.textureIndicesByIdLength = parser.readUInt32();
		header.textureIndicesByIdOffset = parser.readUInt32();
		header.materialsLength = parser.readUInt32();
		header.materialsOffset = parser.readUInt32();
		header.boneLookupTableLength = parser.readUInt32();
		header.boneLookupTableOffset = parser.readUInt32();
		header.textureLookupTableLength = parser.readUInt32();
		header.textureLookupTableOffset = parser.readUInt32();
		header.textureUnitLookupTableLength = parser.readUInt32();
		header.textureUnitLookupTableOffset = parser.readUInt32();

		return header;

	}

	//

	_readMaterials( parser, header ) {

		const length = header.materialsLength;
		const offset = header.materialsOffset;

		parser.saveState();
		parser.moveTo( offset );

		const materials = [];

		for ( let i = 0; i < length; i ++ ) {

			const material = new M2Material();

			material.flags = parser.readUInt16();
			material.blendingMode = parser.readUInt16();

			materials.push( material );

		}

		parser.restoreState();

		return materials;

	}

	_readName( parser, header ) {

		const length = header.nameLength;
		const offset = header.nameOffset;

		parser.saveState();
		parser.moveTo( offset );

		const name = parser.readString( length ).replace( /\0/g, '' ); // remove control characters

		parser.restoreState();

		return name;

	}

	_readTextureDefinitions( parser, header ) {

		const length = header.texturesLength;
		const offset = header.texturesOffset;

		parser.saveState();
		parser.moveTo( offset );

		const textures = [];

		for ( let i = 0; i < length; i ++ ) {

			const texture = this._readTextureDefinition( parser );
			textures.push( texture );

		}

		parser.restoreState();

		return textures;

	}

	_readTextureDefinition( parser ) {

		const texture = new M2Texture();

		texture.type = parser.readUInt32();
		texture.flags = parser.readUInt32();

		const length = parser.readUInt32();
		const offset = parser.readUInt32();

		parser.saveState();
		parser.moveTo( offset );

		let filename = parser.readString( length );
		filename = filename.replace( /\0/g, '' ); // remove control characters
		filename = filename.replace( /^.*[\\\/]/, '' ); // remove directory path
		filename = filename.toLowerCase(); // ensure lowercase characters

		texture.filename = filename;

		parser.restoreState();

		return texture;

	}

	_readTextureLookupTable( parser, header ) {

		const length = header.textureLookupTableLength;
		const offset = header.textureLookupTableOffset;

		parser.saveState();
		parser.moveTo( offset );

		const lookupTable = [];

		for ( let i = 0; i < length; i ++ ) {

			lookupTable.push( parser.readUInt16() );

		}

		parser.restoreState();

		return lookupTable;

	}

	_readVertices( parser, header ) {

		const length = header.verticesLength;
		const offset = header.verticesOffset;

		parser.saveState();
		parser.moveTo( offset );

		const vertices = [];

		for ( let i = 0; i < length; i ++ ) {

			const vertex = this._readVertex( parser );
			vertices.push( vertex );

		}

		parser.restoreState();

		return vertices;

	}

	_readVertex( parser ) {

		const vertex = new M2Vertex();

		vertex.pos.x = parser.readFloat32();
		vertex.pos.y = parser.readFloat32();
		vertex.pos.z = parser.readFloat32();

		vertex.boneWeights.push(
			parser.readUInt8(),
			parser.readUInt8(),
			parser.readUInt8(),
			parser.readUInt8()
		);

		vertex.boneIndices.push(
			parser.readUInt8(),
			parser.readUInt8(),
			parser.readUInt8(),
			parser.readUInt8()
		);

		vertex.normal.x = parser.readFloat32();
		vertex.normal.y = parser.readFloat32();
		vertex.normal.z = parser.readFloat32();

		vertex.texCoords[ 0 ].x = parser.readFloat32();
		vertex.texCoords[ 0 ].y = parser.readFloat32();

		vertex.texCoords[ 1 ].x = parser.readFloat32();
		vertex.texCoords[ 1 ].y = parser.readFloat32();

		return vertex;

	}

}

// const M2_GLOBAL_FLAGS_TILT_X = 0x1;
// const M2_GLOBAL_FLAGS_TILT_Y = 0x2;
// const M2_GLOBAL_FLAGS_USE_TEXTURE_COMBINER_INFOS = 0x8;
// const M2_GLOBAL_FLAGS_LOAD_PHYS_DATA = 0x20;
// const M2_GLOBAL_FLAGS_UNK_1 = 0x80;
// const M2_GLOBAL_FLAGS_CAMERA_RELATED = 0x100;
// const M2_GLOBAL_FLAGS_NEW_PARTICLE_RECORD = 0x200;
// const M2_GLOBAL_FLAGS_UNK_2 = 0x400;
// const M2_GLOBAL_FLAGS_TEXTURE_TRANSFORMS_USE_BONE_SEQUENCES = 0x800;
// const M2_GLOBAL_FLAGS_UNK_3 = 0x1000;
// const M2_GLOBAL_FLAGS_CHUNKED_ANIM_FILES = 0x2000;

// const M2_VERSION_CLASSIC = 256;
const M2_VERSION_THE_BURNING_CRUSADE = 263;
const M2_VERSION_WRATH_OF_THE_LICH_KING = 264;
// const M2_VERSION_CATACLYSM = 272;
// const M2_VERSION_MISTS_OF_PANDARIA = 272;
// const M2_VERSION_WARLORDS_OF_DRAENOR = 272;
const M2_VERSION_LEGION = 274;
// const M2_VERSION_BATTLE_FOR_AZEROTH = 274;
// const M2_VERSION_SHADOWLANDS = 274;

const M2_MATERIAL_UNLIT = 0x01;
const M2_MATERIAL_UNFOGGED = 0x02;
const M2_MATERIAL_TWO_SIDED = 0x04;
const M2_MATERIAL_DEPTH_TEST = 0x08;
const M2_MATERIAL_DEPTH_WRITE = 0x10;

const M2_BLEND_OPAQUE = 0;
const M2_BLEND_ALPHA_KEY = 1;
const M2_BLEND_ALPHA = 2;

//

class M2SkinLoader extends Loader {

	constructor( manager ) {

		super( manager );

		this.header = null;

	}

	setHeader( header ) {

		this.header = header;

	}

	load( url, onLoad, onProgress, onError ) {

		const loader = new FileLoader( this.manager );
		loader.setPath( this.path );
		loader.setResponseType( 'arraybuffer' );
		loader.setRequestHeader( this.requestHeader );
		loader.setWithCredentials( this.withCredentials );
		loader.load( url, ( buffer ) => {

			try {

				onLoad( this.parse( buffer ) );

			} catch ( e ) {

				if ( onError ) {

					onError( e );

				} else {

					console.error( e );

				}

				this.manager.itemError( url );

			}

		}, onProgress, onError );

	}

	parse( buffer ) {

		const parser = new BinaryParser( buffer );
		const header = this.header;

		if ( header.version >= M2_VERSION_WRATH_OF_THE_LICH_KING ) {

			const magic = parser.readString( 4 );

			if ( magic !== 'SKIN' ) {

				throw new Error( 'THREE.M2SkinLoader: Invalid magic data' );

			}

		}

		// header

		const verticesLength = parser.readUInt32();
		const verticesOffset = parser.readUInt32();
		const indicesLength = parser.readUInt32();
		const indicesOffset = parser.readUInt32();
		const bonesLength = parser.readUInt32();
		const bonesOffset = parser.readUInt32();
		const submeshesLength = parser.readUInt32();
		const submeshesOffset = parser.readUInt32();
		const batchesLength = parser.readUInt32();
		const batchesOffset = parser.readUInt32();

		// local vertex list

		const localVertexList = [];

		parser.moveTo( verticesOffset + 0x00 );

		for ( let i = 0; i < verticesLength; i ++ ) {

			localVertexList.push( parser.readUInt16() );

		}

		// indices

		const indices = [];

		parser.moveTo( indicesOffset + 0x00 );

		for ( let i = 0; i < indicesLength; i ++ ) {

			indices.push( parser.readUInt16() );

		}

		// bones

		const bones = [];

		parser.moveTo( bonesOffset + 0x00 );

		for ( let i = 0; i < bonesLength; i ++ ) {

			// each entry represents 4 bone indices

			bones.push( parser.readUInt8(), parser.readUInt8(), parser.readUInt8(), parser.readUInt8() );

		}

		// submeshes

		const submeshes = [];

		parser.moveTo( submeshesOffset + 0x00 );

		for ( let i = 0; i < submeshesLength; i ++ ) {

			const submesh = this._readSubmesh( parser, header );
			submeshes.push( submesh );


		}

		// batches

		const batches = [];

		parser.moveTo( batchesOffset + 0x00 );

		for ( let i = 0; i < batchesLength; i ++ ) {

			const batch = this._readBatch( parser );
			batches.push( batch );


		}

		//

		const boneCountMax = parser.readUInt32();

		// TODO read shadow batches

		return { localVertexList, indices, bones, submeshes, batches, boneCountMax };

	}

	_readBatch( parser ) {

		const batch = new M2Batch();

		batch.flags = parser.readUInt8();
		batch.priorityPlane = parser.readInt8();
		batch.shaderId = parser.readUInt16();
		batch.skinSectionIndex = parser.readUInt16();
		batch.geosetIndex = parser.readUInt16();
		batch.colorIndex = parser.readUInt16();
		batch.materialIndex = parser.readUInt16();
		batch.materialLayer = parser.readUInt16();
		batch.textureCount = parser.readUInt16();
		batch.textureComboIndex = parser.readUInt16();
		batch.textureCoordComboIndex = parser.readUInt16();
		batch.textureWeightComboIndex = parser.readUInt16();
		batch.textureTransformComboIndex = parser.readUInt16();

		return batch;

	}

	_readSubmesh( parser, header ) {

		const submesh = new M2SkinSection();

		submesh.skinSectionId = parser.readUInt16();
		submesh.Level = parser.readUInt16();
		submesh.vertexStart = parser.readUInt16();
		submesh.vertexCount = parser.readUInt16();
		submesh.indexStart = parser.readUInt16();
		submesh.indexCount = parser.readUInt16();
		submesh.boneCount = parser.readUInt16();
		submesh.boneComboIndex = parser.readUInt16();
		submesh.boneInfluences = parser.readUInt16();
		submesh.centerBoneIndex = parser.readUInt16();

		submesh.centerPosition.set(
			parser.readFloat32(),
			parser.readFloat32(),
			parser.readFloat32()
		);

		if ( header.version >= M2_VERSION_THE_BURNING_CRUSADE ) {

			submesh.sortCenterPosition.set(
				parser.readFloat32(),
				parser.readFloat32(),
				parser.readFloat32()
			);

			submesh.sortRadius = parser.readFloat32();

		}

		return submesh;

	}

}

//

class BLPLoader extends Loader {

	constructor( manager ) {

		super( manager );

	}

	load( config, onLoad, onProgress, onError ) {

		const url = config.url;
		const flags = config.flags;

		const loader = new FileLoader( this.manager );
		loader.setPath( this.path );
		loader.setResponseType( 'arraybuffer' );
		loader.setRequestHeader( this.requestHeader );
		loader.setWithCredentials( this.withCredentials );
		loader.load( url, ( buffer ) => {

			try {

				onLoad( this.parse( buffer, flags ) );

			} catch ( e ) {

				if ( onError ) {

					onError( e );

				} else {

					console.error( e );

				}

				this.manager.itemError( url );

			}

		}, onProgress, onError );

	}

	parse( buffer, flags ) {

		const parser = new BinaryParser( buffer );

		const magic = parser.readString( 4 );

		if ( magic !== 'BLP2' ) {

			throw new Error( 'THREE.BLPLoader: Invalid magic data.' );

		}

		// header

		const header = {};

		header.version = parser.readUInt32();
		header.colorEncoding = parser.readUInt8();
		header.alphaSize = parser.readUInt8();
		header.preferredFormat = parser.readUInt8();
		header.hasMips = parser.readUInt8();
		header.width = parser.readUInt32();
		header.height = parser.readUInt32();

		header.mipOffsets = [];
		header.mipSizes = [];

		for ( let i = 0; i < 16; i ++ ) {

			header.mipOffsets.push( parser.readUInt32() );

		}

		header.mipSizes = [];

		for ( let i = 0; i < 16; i ++ ) {

			header.mipSizes.push( parser.readUInt32() );

		}

		// data

		const mipmaps = [];

		let currentWidth = header.width;
		let currentHeight = header.height;

		for ( let i = 0; i < header.mipOffsets.length; i ++ ) {

			const offset = header.mipOffsets[ i ];

			if ( offset === 0 || currentWidth === 0 || currentHeight === 0 ) break;

			const size = header.mipSizes[ i ];
			const data = new Uint8Array( buffer, offset, size );

			mipmaps.push( { data: data, width: currentWidth, height: currentHeight } );

			currentWidth = Math.floor( currentWidth / 2 );
			currentHeight = Math.floor( currentHeight / 2 );

		}

		// setup texture

		let texture;

		if ( header.preferredFormat === BLP_PIXEL_FORMAT_PIXEL_DXT1 ||
			header.preferredFormat === BLP_PIXEL_FORMAT_PIXEL_DXT3 ||
			header.preferredFormat === BLP_PIXEL_FORMAT_PIXEL_DXT5 ||
			header.preferredFormat === BLP_PIXEL_FORMAT_PIXEL_BC5 ) {

			texture = new CompressedTexture( mipmaps, header.width, header.height );
			texture.needsUpdate = true;

			switch ( header.preferredFormat ) {

				case BLP_PIXEL_FORMAT_PIXEL_DXT1:
					texture.format = RGBA_S3TC_DXT1_Format;
					break;

				case BLP_PIXEL_FORMAT_PIXEL_DXT3:
					texture.format = RGBA_S3TC_DXT3_Format;
					break;

				case BLP_PIXEL_FORMAT_PIXEL_DXT5:
					texture.format = RGBA_S3TC_DXT5_Format;
					break;

				case BLP_PIXEL_FORMAT_PIXEL_BC5:
					texture.format = RGBA_BPTC_Format;
					break;

				default:
					throw new Error( 'THREE.BLPLoader: Unsupported compressed texture format: ' + header.preferredFormat );

			}

		} else {

			// TODO Handle uncompressed textures

		}

		//

		if ( flags & 0x1 ) texture.wrapS = RepeatWrapping;
		if ( flags & 0x2 ) texture.wrapT = RepeatWrapping;

		return texture;

	}

}

// const BLP_COLOR_ENCODING_COLOR_JPEG = 0;
// const BLP_COLOR_ENCODING_COLOR_PALETTE = 1;
// const BLP_COLOR_ENCODING_COLOR_DXT = 2;
// const BLP_COLOR_ENCODING_ARGB8888 = 3;

const BLP_PIXEL_FORMAT_PIXEL_DXT1 = 0;
const BLP_PIXEL_FORMAT_PIXEL_DXT3 = 1;
// const BLP_PIXEL_FORMAT_PIXEL_ARGB8888 = 2;
// const BLP_PIXEL_FORMAT_PIXEL_ARGB1555 = 3;
// const BLP_PIXEL_FORMAT_PIXEL_ARGB4444 = 4;
// const BLP_PIXEL_FORMAT_PIXEL_RGB565 = 5;
// const BLP_PIXEL_FORMAT_PIXEL_A8 = 6;
const BLP_PIXEL_FORMAT_PIXEL_DXT5 = 7;
// const BLP_PIXEL_FORMAT_PIXEL_UNSPECIFIED = 8;
// const BLP_PIXEL_FORMAT_PIXEL_ARGB2565 = 9;
const BLP_PIXEL_FORMAT_PIXEL_BC5 = 11;
// const BLP_PIXEL_FORMAT_NUM_PIXEL_FORMATS = 12;

//

class BinaryParser {

	constructor( buffer ) {

		this.view = new DataView( buffer );

		this.offset = 0;
		this.chunkOffset = 0;

		this._savedOffset = - 1;

	}

	moveTo( offset ) {

		this.offset = offset + this.chunkOffset;

	}

	readFloat32() {

		const float = this.view.getFloat32( this.offset, true );
		this.offset += 4;
		return float;

	}

	readInt8() {

		return this.view.getInt8( this.offset ++ );

	}

	readString( bytes ) {

		let string = '';

		for ( let i = 0; i < bytes; i ++ ) {

			string += String.fromCharCode( this.readUInt8() );

		}

		return string;

	}

	readUInt8() {

		return this.view.getUint8( this.offset ++ );

	}

	readUInt16() {

		const int = this.view.getUint16( this.offset, true );
		this.offset += 2;
		return int;

	}

	readUInt32() {

		const int = this.view.getUint32( this.offset, true );
		this.offset += 4;
		return int;

	}

	saveState() {

		this._savedOffset = this.offset;

	}

	restoreState() {

		this.offset = this._savedOffset;

	}

}

// chunks

class M2Batch {

	constructor() {

		this.flags = 0;
		this.priorityPlane = 0;
		this.shader_id = 0;
		this.skinSectionIndex = 0;
		this.geosetIndex = 0;
		this.colorIndex = 0;
		this.materialIndex = 0;
		this.materialLayer = 0;
		this.textureCount = 0;
		this.textureComboIndex = 0;
		this.textureCoordComboIndex = 0;
		this.textureWeightComboIndex = 0;
		this.textureTransformComboIndex = 0;

	}

}

class M2Material {

	constructor() {

		this.flags = 0;
		this.blendingMode = 0;

	}

}

class M2SkinSection {

	constructor() {

		this.skinSectionId = 0;
		this.Level = 0;
		this.vertexStart = 0;
		this.vertexCount = 0;
		this.indexStart = 0;
		this.indexCount = 0;
		this.boneCount = 0;
		this.boneComboIndex = 0;
		this.boneInfluences = 0;
		this.centerBoneIndex = 0;
		this.centerPosition = new Vector3();
		this.sortCenterPosition = new Vector3();
		this.sortRadius = 0;

	}

}

class M2Texture {

	constructor() {

		this.type = 0;
		this.flags = 0;
		this.filename = '';

	}

}


class M2Vertex {

	constructor() {

		this.pos = new Vector3();
		this.boneWeights = [];
		this.boneIndices = [];
		this.normal = new Vector3();
		this.texCoords = [ new Vector2(), new Vector2() ];

	}

}

export { M2Loader, M2SkinLoader, BLPLoader };
