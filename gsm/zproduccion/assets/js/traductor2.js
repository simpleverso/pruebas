var texto = "vacio";
var cantidad = 36;
var lineas = "";
var diccionario = [];

function traductorjs()
{
	txt_familia_toleto.value = "";
	txt_res_didxazapp.value = "";
	txt_res_fundacionjuchitan.value = "";
	validar();
	cortar();
		
}

function buscar(palabra)
{
//var res = "";
//	===//totalmente igual
	
//return res;
}

function cortar()
{
	var fields = texto.split(';');
	lineas = fields;
	cortar2();
}

function cortar2()
{
		lineas.forEach((linea) => 
		{			
			var pedazos = linea.split('","');
			
			  var singleObj = {}
			  singleObj['esp'] = pedazos[0];
			  singleObj['zap'] = pedazos[1];
			  diccionario.push(singleObj);
		})
}

function validar()
{
	if (txt_texto_espanish.value.length<=cantidad && txt_texto_espanish.value.length >= 1) 
	{
		if(texto==="vacio")
		{
			descargar();
		}
	}
	else
	{
		alert("Debes ingresar más de una letra, Solo se aceptan frases cortas de hasta "+cantidad+" caracteres");
	}
}

function descargar()
{
	var request2 = new XMLHttpRequest();
	request2.overrideMimeType('application/x-javascript; charset=utf-8');
	//request2.overrideMimeType('application/x-www-form-urlencoded; charset=utf-1');
	request2.open("GET", 'https://raw.githubusercontent.com/simpleverso/DidxazappWEB/master/BD/BD.txt?token=AAVPZSP6G4LJKMCPXAAIBWK6Y6JUQ', true);
	request2.onload = () => 
	{
		texto = request2.responseText.toString();
	};
	request2.send();
}
