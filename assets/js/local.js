//Gonzalo Santiago Martinez
let net2;
const classifier2 = knnClassifier.create();
const classes = ['A', 'B', 'C'];

async function main() {
  net2 = await mobilenet.load();
  console.log('Modelo Cargado Correctamente');
}
main();

async function app2() 
{
      const addExampleEntrenar = classId => 
  {
    imgEl = document.getElementById('img01');
    activation = net2.infer(imgEl, 'conv_preds');
    classifier2.addExample(activation, 0);
     
     imgEl = document.getElementById('img02');
     activation = net2.infer(imgEl, 'conv_preds');
    classifier2.addExample(activation, 0);
    
     imgEl = document.getElementById('img03');
     activation = net2.infer(imgEl, 'conv_preds');
    classifier2.addExample(activation, 0);
     
     imgEl = document.getElementById('img04');
     activation = net2.infer(imgEl, 'conv_preds');
    classifier2.addExample(activation, 0);
      
     imgEl = document.getElementById('img05');
     activation = net2.infer(imgEl, 'conv_preds');
    classifier2.addExample(activation, 0);
     
     imgEl = document.getElementById('img06');
     activation = net2.infer(imgEl, 'conv_preds');
    classifier2.addExample(activation, 0);
      
      
     //-----------------------------------------
      
      imgEl = document.getElementById('img11');
     activation = net2.infer(imgEl, 'conv_preds');
    classifier2.addExample(activation, 1);
     
     imgEl = document.getElementById('img12');
     activation = net2.infer(imgEl, 'conv_preds');
    classifier2.addExample(activation, 1);
    
     imgEl = document.getElementById('img13');
     activation = net2.infer(imgEl, 'conv_preds');
    classifier2.addExample(activation, 1);
     
     imgEl = document.getElementById('img14');
     activation = net2.infer(imgEl, 'conv_preds');
    classifier2.addExample(activation, 1);
      
     imgEl = document.getElementById('img15');
     activation = net2.infer(imgEl, 'conv_preds');
    classifier2.addExample(activation, 1);
     
     imgEl = document.getElementById('img16');
     activation = net2.infer(imgEl, 'conv_preds');
    classifier2.addExample(activation, 1);
      
      
    //---------------------------------------
      
      imgEl = document.getElementById('img21');
     activation = net2.infer(imgEl, 'conv_preds');
    classifier2.addExample(activation, 2);
     
     imgEl = document.getElementById('img22');
     activation = net2.infer(imgEl, 'conv_preds');
    classifier2.addExample(activation, 2);
    
     imgEl = document.getElementById('img23');
     activation = net2.infer(imgEl, 'conv_preds');
    classifier2.addExample(activation, 2);
     
     imgEl = document.getElementById('img24');
     activation = net2.infer(imgEl, 'conv_preds');
    classifier2.addExample(activation, 2);
      
     imgEl = document.getElementById('img25');
     activation = net2.infer(imgEl, 'conv_preds');
    classifier2.addExample(activation, 2);
     
     imgEl = document.getElementById('img26');
     activation = net2.infer(imgEl, 'conv_preds');
    classifier2.addExample(activation, 2);
      
      alert("Entrenado");
  }
 // Leer los datos de las imagenes cargadas
  const addExample2 = classId => 
  {
     
      
//generar activacion desde img
      test01 = document.getElementById('test01');
      activation1 = net2.infer(test01, 'conv_preds');
      const result1 = classifier2.predictClass(activation1);
console.log(`Clase Resultante: ${classes[result1.classIndex]}\n`);
      alert(`Test01 - Clase Resultante: ${classes[result1.classIndex]}\n`);
      
      imgEl = document.getElementById('test02');
      activation = net2.infer(imgEl, 'conv_preds');
      result = classifier2.predictClass(activation);
console.log(`Clase Resultante: ${classes[result.classIndex]}\n`);
      alert(`Test02 - Clase Resultante: ${classes[result.classIndex]}\n`);
      
      imgEl = document.getElementById('test03');
      activation = net2.infer(imgEl, 'conv_preds');
      result = classifier2.predictClass(activation);
console.log(`Clase Resultante: ${classes[result.classIndex]}\n`);
      alert(`Test03 - Clase Resultante: ${classes[result.classIndex]}\n`);
      
      imgEl = document.getElementById('test04');
      activation = net2.infer(imgEl, 'conv_preds');
      result = classifier2.predictClass(activation);
console.log(`Clase Resultante: ${classes[result.classIndex]}\n`);
      alert(`Test04 - Clase Resultante: ${classes[result.classIndex]}\n`);
      
      imgEl = document.getElementById('test05');
       activation = net2.infer(imgEl, 'conv_preds');
       result = classifier2.predictClass(activation);
console.log(`Clase Resultante: ${classes[result.classIndex]}\n`);
      alert(`Test05 - Clase Resultante: ${classes[result.classIndex]}\n`);
      
      imgEl = document.getElementById('test06');
      activation = net2.infer(imgEl, 'conv_preds');
      result = classifier2.predictClass(activation);
console.log(`Clase Resultante: ${classes[result.classIndex]}\n`);
      alert(`Test06 - Clase Resultante: ${classes[result.classIndex]}\n`);
      
  };

  // Agregar ejemplo a la clase desde el boton.
  document.getElementById('btn2').addEventListener('click', () => addExampleEntrenar(0));
  document.getElementById('btn3').addEventListener('click', () => addExample2(0));

}
app2();