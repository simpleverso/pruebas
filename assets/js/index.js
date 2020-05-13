//Gonzalo Santiago Martinez
let net;
const classifier = knnClassifier.create();
const webcamElement = document.getElementById('webcam');
const videoSelect = document.querySelector('select#videoSource');
const selectors = [videoSelect];

function gotDevices(deviceInfos) {
  // Handles being called several times to update labels. Preserve values.
  const values = selectors.map(select => select.value);
  selectors.forEach(select => {
    while (select.firstChild) {
      select.removeChild(select.firstChild);
    }
  });
  for (let i = 0; i !== deviceInfos.length; ++i) {
    const deviceInfo = deviceInfos[i];
    const option = document.createElement('option');
    option.value = deviceInfo.deviceId;
    if (deviceInfo.kind === 'videoinput') {
      option.text = deviceInfo.label || `camera ${videoSelect.length + 1}`;
      videoSelect.appendChild(option);
    } else {
      console.log('Some other kind of source/device: ', deviceInfo);
    }
  }
  selectors.forEach((select, selectorIndex) => {
    if (Array.prototype.slice.call(select.childNodes).some(n => n.value === values[selectorIndex])) {
      select.value = values[selectorIndex];
    }
  });
}

navigator.mediaDevices.enumerateDevices().then(gotDevices).catch(handleError);

function gotStream(stream) {
  window.stream = stream;
  webcamElement.srcObject = stream;
  return navigator.mediaDevices.enumerateDevices();
}

function handleError(error) {
  console.log('navigator.MediaDevices.getUserMedia error: ', error.message, error.name);
}

function start() 
{
  if (window.stream) {
    window.stream.getTracks().forEach(track => {
      track.stop();
    });
  }

  const videoSource = videoSelect.value;
  const constraints = 
 {video: {deviceId: videoSource ? {exact: videoSource} : undefined}};
  navigator.mediaDevices.getUserMedia(constraints).then(gotStream).then(gotDevices).catch(handleError);}

videoSelect.onchange = start;
start();


async function app() {
  // Lectura del modelo
  net = await mobilenet.load();
  console.log('Modelo Cargado Correctamente');
  //await setupWebcam();
    
    
  //// Leer una imagen desde la webcam y asociarla a un indice
 // const addExample = classId => 
 // {
    // //obtener activacion intermedia /inferecia
   // const activation = net.infer(webcamElement, 'conv_preds');
   // //enviar al proceso de clasificacion
   // classifier.addExample(activation, classId);
  //};
    
 // Leer los datos de las imagenes cargadas
  const addExample = classId => 
  {
    //--------------------------------------------
    
    imgEl = document.getElementById('img01');
    activation = net.infer(imgEl, 'conv_preds');
    classifier.addExample(activation, 0);
     
     imgEl = document.getElementById('img02');
     activation = net.infer(imgEl, 'conv_preds');
    classifier.addExample(activation, 0);
    
     imgEl = document.getElementById('img03');
     activation = net.infer(imgEl, 'conv_preds');
    classifier.addExample(activation, 0);
     
     imgEl = document.getElementById('img04');
     activation = net.infer(imgEl, 'conv_preds');
    classifier.addExample(activation, 0);
      
     imgEl = document.getElementById('img05');
     activation = net.infer(imgEl, 'conv_preds');
    classifier.addExample(activation, 0);
     
     imgEl = document.getElementById('img06');
     activation = net.infer(imgEl, 'conv_preds');
    classifier.addExample(activation, 0);
      
      
     //-----------------------------------------
      
      imgEl = document.getElementById('img11');
     activation = net.infer(imgEl, 'conv_preds');
    classifier.addExample(activation, 1);
     
     imgEl = document.getElementById('img12');
     activation = net.infer(imgEl, 'conv_preds');
    classifier.addExample(activation, 1);
    
     imgEl = document.getElementById('img13');
     activation = net.infer(imgEl, 'conv_preds');
    classifier.addExample(activation, 1);
     
     imgEl = document.getElementById('img14');
     activation = net.infer(imgEl, 'conv_preds');
    classifier.addExample(activation, 1);
      
     imgEl = document.getElementById('img15');
     activation = net.infer(imgEl, 'conv_preds');
    classifier.addExample(activation, 1);
     
     imgEl = document.getElementById('img16');
     activation = net.infer(imgEl, 'conv_preds');
    classifier.addExample(activation, 1);
      
      
    //---------------------------------------
      
      imgEl = document.getElementById('img21');
     activation = net.infer(imgEl, 'conv_preds');
    classifier.addExample(activation, 2);
     
     imgEl = document.getElementById('img22');
     activation = net.infer(imgEl, 'conv_preds');
    classifier.addExample(activation, 2);
    
     imgEl = document.getElementById('img23');
     activation = net.infer(imgEl, 'conv_preds');
    classifier.addExample(activation, 2);
     
     imgEl = document.getElementById('img24');
     activation = net.infer(imgEl, 'conv_preds');
    classifier.addExample(activation, 2);
      
     imgEl = document.getElementById('img25');
     activation = net.infer(imgEl, 'conv_preds');
    classifier.addExample(activation, 2);
     
     imgEl = document.getElementById('img26');
     activation = net.infer(imgEl, 'conv_preds');
    classifier.addExample(activation, 2);
      
      alert("Entrenado");
      
  };

  // Agregar ejemplo a la clase desde el boton.
  document.getElementById('btn1').addEventListener('click', () => addExample(0));

  while (true) {
    if (classifier.getNumClasses() > 0) {
     
    //generar activacion desde camara
      const activation = net.infer(webcamElement, 'conv_preds');
    //predecir
      const result = await classifier.predictClass(activation);
      const classes = ['A', 'B', 'C'];
      document.getElementById('console').innerText = `
        Clase Resultante: ${classes[result.classIndex]}\n`;
//probability: ${result.confidences[result.classIndex]}`;
    }
    await tf.nextFrame();
  }
}
app();