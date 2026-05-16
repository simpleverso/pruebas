/* global txt_familia_toleto */
/* global txt_res_didxazapp */
/* global txt_texto_espanish */
/* global txt_res_fundacionjuchitan */

function showAlert(text) {
    window.alert(text);
    return false;
}

function traductorjs()
{
	//showAlert('Buscando...');
	document.getElementById("btn_traduc").outerHTML = "<button id=\"btn_traduc\" name=\"btn_traducir\" onclick=\"traductorjs()\" class=\"btn btn-primary\" type=\"button\">Traduciendo...</button>";
	txt_familia_toleto.value = "";
	txt_res_didxazapp.value = "";
	txt_res_fundacionjuchitan.value = "";
	var cantidad = 36;
	var decide = Math.round(Math.random() * 10);
	//console.log(decide);
	var url = "";
	var url2 = "";
	var url3 = "";
	
	if( decide== 1 || decide==2)
	{
		 url = "https://didxazapp1.azurewebsites.net/service/didxaza.asmx/TraductorTOLEDO?palabra={0}&clave={1}";
		 url2 = "https://didxazapp1.azurewebsites.net/service/didxaza.asmx/quierofraseenzapotecoclave?damelafraseenespaniol={0}&clave={1}";
		 url3 = "https://didxazapp1.azurewebsites.net/service/didxaza.asmx/TraductorfundacionJuchitan?palabra={0}&clave={1}";
	}
	if ( decide == 5 || decide == 7)
	{
		url = "https://didxazapp2.azurewebsites.net/service/didxaza.asmx/TraductorTOLEDO?palabra={0}&clave={1}";
		 url2 = "https://didxazapp2.azurewebsites.net/service/didxaza.asmx/quierofraseenzapotecoclave?damelafraseenespaniol={0}&clave={1}";
		 url3 = "https://didxazapp2.azurewebsites.net/service/didxaza.asmx/TraductorfundacionJuchitan?palabra={0}&clave={1}";
	}
	else
	{
		 url = "https://didxazapp4.azurewebsites.net/service/didxaza.asmx/TraductorTOLEDO?palabra={0}&clave={1}";
		 url2 = "https://didxazapp4.azurewebsites.net/service/didxaza.asmx/quierofraseenzapotecoclave?damelafraseenespaniol={0}&clave={1}";
		 url3 = "https://didxazapp4.azurewebsites.net/service/didxaza.asmx/TraductorfundacionJuchitan?palabra={0}&clave={1}";
	}
	
	//var url = "https://traductorzapoteco.azurewebsites.net/service/didxaza.asmx/TraductorTOLEDO?palabra={0}&clave={1}";
	//var url2 = "https://traductorzapoteco.azurewebsites.net/service/didxaza.asmx/quierofraseenzapotecoclave?damelafraseenespaniol={0}&clave={1}";
	//var url3 = "https://traductorzapoteco.azurewebsites.net/service/didxaza.asmx/TraductorfundacionJuchitan?palabra={0}&clave={1}";

	if (txt_texto_espanish.value.length<=cantidad && txt_texto_espanish.value.length >= 1) 
	{
		//alert("entra");
		var textoobtenido = txt_texto_espanish.value;
		url = url.replace(/\{0\}/g, textoobtenido.trim());
	 	url = url.replace(/\{1\}/g, "p");
		url2 = url2.replace(/\{0\}/g, textoobtenido.trim());
		url2 = url2.replace(/\{1\}/g, "p");
		url3 = url3.replace(/\{0\}/g, textoobtenido.trim());
		url3 = url3.replace(/\{1\}/g, "p");
		
	////////////////////////////////////////////////////////DIDXAZAPP
	
		var request2 = new XMLHttpRequest();
		request2.overrideMimeType('application/x-javascript; charset=utf-8');
		//request2.overrideMimeType('application/x-www-form-urlencoded; charset=utf-1');
		request2.open("GET", url2, true);
		request2.onload = () => 
		{
			var textoRecuperado = request2.responseText.toString().substr(107,request2.responseText.length);
			var pedazos = textoRecuperado.split("</string>");
			//console.log(pedazos[0]);
			pedazos[0] = pedazos[0].replace("Ã¡","á").replace("Ã©","é").replace("Ã","í").replace("Ã³","ó").replace("Ãº","ú");
			pedazos[0] = pedazos[0].replace("íº","ú"); //añadir a github
			pedazos[0] = pedazos[0].replace("Ã¡","á").replace("í¡","á");
			txt_res_didxazapp.value += pedazos[0].toString();
			document.getElementById("btn_traduc").outerHTML = "<button id=\"btn_traduc\" name=\"btn_traducir\" onclick=\"traductorjs()\" class=\"btn btn-primary\" type=\"button\">Traducir</button>";
			//document.getElementById("btn_traduc").outerHTML = "<button id=\"btn_traduc\" name=\"btn_traducir\" onclick=\"traductorjs()\" class=\"btn btn-primary\" type=\"button\">No disponible por el momento...</button>";
		};
		request2.send();

	///////////////////////////////////////////////////FUNDACION JUCHITAN
		
		var request3 = new XMLHttpRequest();
		request3.overrideMimeType('application/x-javascript; charset=utf-8');
		request3.open("GET", url3, true);
		request3.onload = () => 
		{
			var textoRecuperado = request3.responseText.toString();
			var pedazos = textoRecuperado.split("<string>");
			pedazos[1] = pedazos[1].replace("Definiciones:"," ");
			pedazos[1] = pedazos[1].replace("</string>"," ");
			pedazos[1] = pedazos[1].replace("-&gt;","-->");
			pedazos[1] = pedazos[1].replace("-","-->");
			pedazos[1] = pedazos[1].replace("<string /></ArrayOfString>"," ");
			pedazos[1] = pedazos[1].replace("-->->","-->");
			//console.log(textoRecuperado);  //Definiciones:
			pedazos[1] = pedazos[1].replace("Ã¡","á").replace("Ã©","é").replace("Ã","í").replace("Ã³","ó").replace("Ãº","ú"); //añadir a github
			pedazos[1] = pedazos[1].replace("íº","ú"); 
			pedazos[1] = pedazos[1].replace("Ã¡","á").replace("í¡","á");
			if(pedazos[1].includes("Error Grave.")) // validar informacion
			{
				txt_res_fundacionjuchitan.value += "No se pudo obtener informacion de: http://www.zapotecoteco.org.mx/";
			}
			else
			{
				txt_res_fundacionjuchitan.value += pedazos[1];
			}
			document.getElementById("btn_traduc").outerHTML = "<button id=\"btn_traduc\" name=\"btn_traducir\" onclick=\"traductorjs()\" class=\"btn btn-primary\" type=\"button\">Traducir</button>";
			//document.getElementById("btn_traduc").outerHTML = "<button id=\"btn_traduc\" name=\"btn_traducir\" onclick=\"traductorjs()\" class=\"btn btn-primary\" type=\"button\">No disponible por el momento...</button>";
		};
		request3.send();
		
	  //////////////////////////////////////////////////////////TOLEDO
		
		var request = new XMLHttpRequest();
		request.overrideMimeType('application/x-javascript; charset=utf-8');
		request.open("GET", url, true);
		request.onload = () => 
		{
			var textoRecuperado = request.responseText.toString().substr(213,request.responseText.length-172);
			
			var pedazos = textoRecuperado.split("<string>");
			pedazos[1] = pedazos[1].replace("</string>","").replace("</ArrayOfString>","");
			pedazos[2] = pedazos[2].replace("</string>","").replace("</ArrayOfString>","");
			
			pedazos[1] = pedazos[1].replace("Ã¡","á").replace("Ã©","é").replace("Ã","í").replace("Ã³","ó").replace("Ãº","ú"); //añadir a github
			pedazos[1] = pedazos[1].replace("íº","ú"); 
			pedazos[1] = pedazos[1].replace("Ã¡","á").replace("í¡","á");
			
			pedazos[2] = pedazos[2].replace("Ã¡","á").replace("Ã©","é").replace("Ã","í").replace("Ã³","ó").replace("Ãº","ú"); //añadir a github
			pedazos[2] = pedazos[2].replace("íº","ú"); 
			pedazos[2] = pedazos[2].replace("Ã¡","á").replace("í¡","á");
			
			var text1 = "";
			var re = pedazos[1].split("|");
			for (var index = 0; index < re.length; index++) 
			{
				 text1 += re[index]+"-->";
			}
			text1 = text1.replace("Definiciones:","Definiciones: \n");
			
			var text0="";
			var ped1 = text1.split("~");
			for (var index = 0; index < ped1.length; index++) 
			{
				 text0 += ped1[index]+"\n";
			}
			
			var text2 = "";
			var re2 = pedazos[2].split("|");
			for (var index = 0; index < re2.length; index++) 
			{
				 text2 += re2[index]+"-->";
			}
			text2 = text2.replace("Ejemplos:","Ejemplos: \n");
			
			var text3="";
			var ped2 = text2.split("~");
			for (var index = 0; index < ped2.length; index++) 
			{
				 text3 += ped2[index]+"\n";
			}
			text0 = text0.replace("Definiciones: ","");
			
			if(text0.indexOf("-->", text0.length - "-->".length)) //quita restos de --> en la ultima linea
			{
				text0 = text0.substring(0, text0.length - 4);
			}
			
			txt_familia_toleto.value += text0.toString().trim();
			document.getElementById("btn_traduc").outerHTML = "<button id=\"btn_traduc\" name=\"btn_traducir\" onclick=\"traductorjs()\" class=\"btn btn-primary\" type=\"button\">Traducir</button>";
			//document.getElementById("btn_traduc").outerHTML = "<button id=\"btn_traduc\" name=\"btn_traducir\" onclick=\"traductorjs()\" class=\"btn btn-primary\" type=\"button\">No disponible por el momento...</button>";
		};
		request.send();	
	}
	else
	{
		alert("Debes ingresar más de una letra, Solo se aceptan frases cortas de hasta "+cantidad+" caracteres");
	}	
}
